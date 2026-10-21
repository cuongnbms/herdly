use herdly_web::auth::*;
use herdly_web::store::Store;
use std::os::unix::fs::PermissionsExt;

fn store() -> (tempfile::TempDir, Store) {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(&d.path().join("state")).unwrap();
    (d, s)
}

#[test]
fn state_dir_and_files_are_private() {
    let (_d, s) = store();
    start_pairing(&s, 1000).unwrap();
    assert_eq!(
        std::fs::metadata(&s.dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let f = std::fs::metadata(s.dir.join("pairing.json")).unwrap();
    assert_eq!(f.permissions().mode() & 0o777, 0o600);
}

#[test]
fn token_is_43_url_safe_chars_and_stored_only_hashed() {
    let (_d, s) = store();
    let t = start_pairing(&s, 1000).unwrap();
    assert_eq!(t.len(), 43);
    assert!(t
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    let raw = std::fs::read_to_string(s.dir.join("pairing.json")).unwrap();
    assert!(!raw.contains(&t));
    assert!(raw.contains(&sha256_hex(&t)));
}

#[test]
fn pairing_link_works_once_and_expires_after_ten_minutes() {
    let (_d, s) = store();
    let t = start_pairing(&s, 1000).unwrap();
    let (dev, cookie) = complete_pairing(&s, &t, "Mozilla/5.0 (Linux; Android 15)", 1599).unwrap();
    assert_eq!(dev.name, "Mozilla/5.0 (Linux; Android 15)");
    assert_eq!(dev.cookie_sha256, sha256_hex(&cookie));
    assert!(!s.dir.join("pairing.json").exists());
    assert_eq!(
        complete_pairing(&s, &t, "x", 1599).unwrap_err().code,
        "forbidden"
    );

    let t2 = start_pairing(&s, 2000).unwrap();
    assert_eq!(
        complete_pairing(&s, &t2, "x", 2600).unwrap_err().code,
        "forbidden"
    );
}

#[test]
fn a_new_pair_replaces_the_pending_one() {
    let (_d, s) = store();
    let old = start_pairing(&s, 1000).unwrap();
    let new = start_pairing(&s, 1001).unwrap();
    assert_eq!(
        complete_pairing(&s, &old, "x", 1002).unwrap_err().code,
        "forbidden"
    );
    assert!(complete_pairing(&s, &new, "x", 1002).is_ok());
}

#[test]
fn check_accepts_the_cookie_and_sees_a_revoke() {
    let (_d, s) = store();
    let t = start_pairing(&s, 1000).unwrap();
    let (dev, cookie) = complete_pairing(&s, &t, "phone", 1001).unwrap();
    let auth = Auth::new(s.clone());
    assert_eq!(
        auth.check(&cookie, 1002).map(|i| i.device_id),
        Some(dev.id.clone())
    );
    assert_eq!(auth.check("not-a-cookie", 1002), None);
    std::thread::sleep(std::time::Duration::from_millis(20)); // a distinct mtime
    assert!(revoke(&s, &dev.id).unwrap());
    assert_eq!(auth.check(&cookie, 1003), None);
    assert!(!auth.is_live(&dev.id));
}

#[test]
fn last_seen_is_written_at_most_hourly_and_never_resurrects_a_revoked_device() {
    let (_d, s) = store();
    let t = start_pairing(&s, 1000).unwrap();
    let (dev, cookie) = complete_pairing(&s, &t, "phone", 1000).unwrap();
    let auth = Auth::new(s.clone());
    auth.check(&cookie, 1000 + 3599);
    assert_eq!(list_devices(&s).unwrap()[0].last_seen, 1000);
    auth.check(&cookie, 1000 + 3600);
    assert_eq!(list_devices(&s).unwrap()[0].last_seen, 4600);

    // The cache still holds the device; a revoke lands; the next hourly write must not undo it.
    revoke(&s, &dev.id).unwrap();
    auth.check(&cookie, 4600 + 3600);
    assert!(list_devices(&s).unwrap().is_empty());
}

#[test]
fn a_revoke_the_cache_missed_is_caught_by_the_hourly_write() {
    let (_d, s) = store();
    let t = start_pairing(&s, 1000).unwrap();
    let (dev, cookie) = complete_pairing(&s, &t, "phone", 1000).unwrap();
    let auth = Auth::new(s.clone());
    assert!(auth.check(&cookie, 1001).is_some()); // loads the cache
    let path = s.dir.join("devices.json");
    let seen = std::fs::metadata(&path).unwrap().modified().unwrap();
    revoke(&s, &dev.id).unwrap();
    // Put the old mtime back so the cache cannot tell the file changed.
    let f = std::fs::File::options().write(true).open(&path).unwrap();
    f.set_modified(seen).unwrap();
    drop(f);
    assert_eq!(auth.check(&cookie, 1000 + 3600), None);
    assert_eq!(auth.check(&cookie, 1000 + 3601), None);
    assert!(list_devices(&s).unwrap().is_empty());
}
