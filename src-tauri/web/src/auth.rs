//! Paired devices and pairing tokens.
use crate::config::{LAST_SEEN_EVERY_SECS, PAIRING_TTL_SECS};
use crate::store::Store;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use herdly_core::error::AppError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io;
use std::sync::Mutex;
use std::time::SystemTime;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub cookie_sha256: String,
    pub created: i64,
    pub last_seen: i64,
}

#[derive(Default, Serialize, Deserialize)]
pub struct Devices {
    pub devices: Vec<Device>,
}

#[derive(Serialize, Deserialize)]
pub struct Pairing {
    pub token_sha256: String,
    pub expires: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DeviceInfo {
    pub device_id: String,
    pub name: String,
}

pub fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// 32 random bytes, base64 URL-safe without padding (43 chars).
pub fn random_token() -> String {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("OS randomness unavailable");
    URL_SAFE_NO_PAD.encode(b)
}

const PAIRING: &str = "pairing.json";
const DEVICES: &str = "devices.json";

/// Writes a fresh pending pairing (replacing any older one) and returns the token.
pub fn start_pairing(store: &Store, now: i64) -> io::Result<String> {
    let token = random_token();
    let pairing = Pairing {
        token_sha256: sha256_hex(&token),
        expires: now + PAIRING_TTL_SECS,
    };
    store.locked(|s| s.write_json(PAIRING, &pairing))?;
    Ok(token)
}

fn io_err(e: io::Error) -> AppError {
    AppError::new("io", e.to_string())
}

/// Consumes the pending pairing if `token` matches and has not expired, and registers a device.
pub fn complete_pairing(
    store: &Store,
    token: &str,
    user_agent: &str,
    now: i64,
) -> Result<(Device, String), AppError> {
    let denied = || AppError::new("forbidden", "pairing link expired or used");
    store
        .locked(|s| {
            let pending: Option<Pairing> = s.read_json(PAIRING)?;
            let ok =
                pending.is_some_and(|p| p.token_sha256 == sha256_hex(token) && now < p.expires);
            if !ok {
                return Ok(None);
            }
            let cookie = random_token();
            let name: String = user_agent.chars().take(80).collect();
            let device = Device {
                id: sha256_hex(&random_token())[..8].to_string(),
                name: if name.is_empty() {
                    "unknown".to_string()
                } else {
                    name
                },
                cookie_sha256: sha256_hex(&cookie),
                created: now,
                last_seen: now,
            };
            let mut all: Devices = s.read_json(DEVICES)?;
            all.devices.push(device.clone());
            s.write_json(DEVICES, &all)?;
            s.remove(PAIRING)?;
            Ok(Some((device, cookie)))
        })
        .map_err(io_err)?
        .ok_or_else(denied)
}

pub fn list_devices(store: &Store) -> io::Result<Vec<Device>> {
    store.locked(|s| Ok(s.read_json::<Devices>(DEVICES)?.devices))
}

/// Returns whether a device with that id existed.
pub fn revoke(store: &Store, id: &str) -> io::Result<bool> {
    store.locked(|s| {
        let mut all: Devices = s.read_json(DEVICES)?;
        let before = all.devices.len();
        all.devices.retain(|d| d.id != id);
        let found = all.devices.len() != before;
        if found {
            s.write_json(DEVICES, &all)?;
        }
        Ok(found)
    })
}

#[derive(Default)]
struct Cache {
    mtime: Option<SystemTime>,
    loaded: bool,
    by_hash: HashMap<String, Device>,
}

/// Cookie lookups for the HTTP router. The cache holds only what lookups need; every write goes
/// back through `devices.json` under the lock.
pub struct Auth {
    store: Store,
    cache: Mutex<Cache>,
}

impl Auth {
    pub fn new(store: Store) -> Auth {
        Auth {
            store,
            cache: Mutex::new(Cache::default()),
        }
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    fn reload(&self, c: &mut Cache) {
        let m = self.store.mtime(DEVICES);
        if c.loaded && c.mtime == m {
            return;
        }
        // On a read error keep serving the old cache and retry on the next call.
        if let Ok(all) = self.store.locked(|s| s.read_json::<Devices>(DEVICES)) {
            c.by_hash = all
                .devices
                .into_iter()
                .map(|d| (d.cookie_sha256.clone(), d))
                .collect();
            c.mtime = m;
            c.loaded = true;
        }
    }

    pub fn check(&self, cookie: &str, now: i64) -> Option<DeviceInfo> {
        let hash = sha256_hex(cookie);
        let mut c = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        self.reload(&mut c);
        let dev = c.by_hash.get(&hash)?.clone();
        if now - dev.last_seen >= LAST_SEEN_EVERY_SECS {
            let written = self.store.locked(|s| {
                let mut all: Devices = s.read_json(DEVICES)?;
                match all.devices.iter_mut().find(|d| d.id == dev.id) {
                    Some(d) => {
                        d.last_seen = now;
                        s.write_json(DEVICES, &all)?;
                        Ok(true)
                    }
                    None => Ok(false), // revoked meanwhile: never re-add
                }
            });
            if let (Ok(true), Some(d)) = (written, c.by_hash.get_mut(&hash)) {
                d.last_seen = now; // no second write inside the hour; the mtime change reloads
            }
        }
        Some(DeviceInfo {
            device_id: dev.id,
            name: dev.name,
        })
    }

    pub fn is_live(&self, device_id: &str) -> bool {
        let mut c = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        self.reload(&mut c);
        c.by_hash.values().any(|d| d.id == device_id)
    }
}
