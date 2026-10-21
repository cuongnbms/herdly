//! Decoded chat images, kept in memory per tail under a byte budget.
use base64::{engine::general_purpose::STANDARD, Engine};
use std::collections::{HashMap, VecDeque};

/// Decoded bytes kept per tail before the oldest images are evicted.
pub const IMAGE_BUDGET: usize = 64 * 1024 * 1024;
/// The budget of a parked tail's store: nobody is looking, so keep less.
pub const PARKED_IMAGE_BUDGET: usize = 16 * 1024 * 1024;

/// Where a parser puts the decoded bytes of an image it found.
pub trait ImageSink {
    fn put(&mut self, r: String, media_type: String, bytes: Vec<u8>);
}

impl ImageSink for Vec<(String, String, Vec<u8>)> {
    fn put(&mut self, r: String, media_type: String, bytes: Vec<u8>) {
        self.push((r, media_type, bytes));
    }
}

/// Images by ref, evicting the oldest once the budget is exceeded.
pub struct ImageStore {
    budget: usize,
    used: usize,
    map: HashMap<String, (String, Vec<u8>)>,
    order: VecDeque<String>,
}

impl ImageStore {
    pub fn new(budget: usize) -> Self {
        Self {
            budget,
            used: 0,
            map: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    pub fn get(&self, r: &str) -> Option<(String, Vec<u8>)> {
        self.map.get(r).cloned()
    }

    /// Sets the budget, evicting oldest first down to it.
    pub fn set_budget(&mut self, budget: usize) {
        self.budget = budget;
        self.evict();
    }

    fn evict(&mut self) {
        while self.used > self.budget {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some((_, b)) = self.map.remove(&oldest) {
                self.used -= b.len();
            }
        }
    }
}

impl ImageSink for ImageStore {
    fn put(&mut self, r: String, media_type: String, bytes: Vec<u8>) {
        if bytes.len() > self.budget {
            return;
        }
        if let Some((_, old)) = self.map.remove(&r) {
            self.used -= old.len();
            self.order.retain(|k| k != &r);
        }
        self.used += bytes.len();
        self.order.push_back(r.clone());
        self.map.insert(r, (media_type, bytes));
        self.evict();
    }
}

/// Decodes base64 image data; None for a type other than png, jpeg, gif or webp, or bad base64.
pub fn decode_image(media_type: &str, data: &str) -> Option<Vec<u8>> {
    match media_type {
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" => STANDARD.decode(data).ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn evicts_oldest_past_budget() {
        let mut s = ImageStore::new(10);
        s.put("a".into(), "image/png".into(), vec![0; 4]);
        s.put("b".into(), "image/png".into(), vec![1; 4]);
        s.put("c".into(), "image/png".into(), vec![2; 4]);
        assert!(s.get("a").is_none());
        assert_eq!(s.get("b"), Some(("image/png".into(), vec![1; 4])));
        assert_eq!(s.get("c"), Some(("image/png".into(), vec![2; 4])));
    }
    #[test]
    fn shrinking_the_budget_evicts_oldest_first() {
        let mut s = ImageStore::new(10);
        s.put("a".into(), "image/png".into(), vec![0; 4]);
        s.put("b".into(), "image/png".into(), vec![1; 4]);
        s.set_budget(5);
        assert_eq!(s.get("a"), None);
        assert!(s.get("b").is_some());
        s.set_budget(10);
        s.put("c".into(), "image/png".into(), vec![2; 4]);
        assert!(s.get("b").is_some() && s.get("c").is_some());
    }
    #[test]
    fn skips_an_image_larger_than_the_budget() {
        let mut s = ImageStore::new(10);
        s.put("a".into(), "image/png".into(), vec![0; 4]);
        s.put("big".into(), "image/png".into(), vec![0; 11]);
        assert!(s.get("big").is_none());
        assert!(s.get("a").is_some());
    }
    #[test]
    fn replacing_a_ref_does_not_double_count() {
        let mut s = ImageStore::new(10);
        s.put("a".into(), "image/png".into(), vec![0; 6]);
        s.put("a".into(), "image/png".into(), vec![1; 6]);
        s.put("b".into(), "image/png".into(), vec![2; 4]);
        assert_eq!(s.get("a"), Some(("image/png".into(), vec![1; 6])));
        assert!(s.get("b").is_some());
    }
    #[test]
    fn decodes_only_kept_types() {
        assert_eq!(decode_image("image/png", "AQID"), Some(vec![1, 2, 3]));
        assert_eq!(decode_image("image/webp", "AQID"), Some(vec![1, 2, 3]));
        assert_eq!(decode_image("image/svg+xml", "AQID"), None);
        assert_eq!(decode_image("image/png", "not base64!"), None);
    }
}
