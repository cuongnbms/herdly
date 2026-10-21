//! Constants shared by the server modules.
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const DEFAULT_BIND: &str = "192.0.2.10:7380";
pub const COOKIE_NAME: &str = "herdly_web";
pub const COOKIE_MAX_AGE: i64 = 31_536_000;
pub const PAIRING_TTL_SECS: i64 = 600;
pub const LAST_SEEN_EVERY_SECS: i64 = 3600;
pub const REVOKE_CHECK: Duration = Duration::from_secs(15);
pub const BODY_LIMIT: usize = 1024 * 1024;
pub const CLOSE_LAGGED: u16 = 4000;
pub const CLOSE_REVOKED: u16 = 4401;
pub const PENDING_RETRY: Duration = Duration::from_millis(1500);
pub const CHANNEL_CAP: usize = 256;

/// The wall clock as Unix seconds. Only `main.rs` and handlers call it.
pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
