//! The `<state>` directory: private files changed under an exclusive lock.
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs::{DirBuilder, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Clone)]
pub struct Store {
    pub dir: PathBuf,
}

impl Store {
    /// Creates the directory (and parents) with mode `0700`; an existing one is tightened to `0700`.
    pub fn open(dir: &Path) -> io::Result<Store> {
        DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        Ok(Store {
            dir: dir.to_path_buf(),
        })
    }

    /// Runs `f` holding an exclusive `flock` on `<dir>/.lock`. Not re-entrant: a nested call on
    /// the same directory would block forever, so `f` must not call `locked` again.
    pub fn locked<T>(&self, f: impl FnOnce(&Store) -> io::Result<T>) -> io::Result<T> {
        let lock: File = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .open(self.dir.join(".lock"))?;
        loop {
            // SAFETY: the fd is valid for as long as `lock` lives.
            if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } == 0 {
                break;
            }
            let e = io::Error::last_os_error();
            if e.kind() != io::ErrorKind::Interrupted {
                return Err(e);
            }
        }
        let out = f(self);
        drop(lock); // closing the descriptor releases the lock
        out
    }

    /// A missing file reads as `T::default()`.
    pub fn read_json<T: DeserializeOwned + Default>(&self, name: &str) -> io::Result<T> {
        match std::fs::read(self.dir.join(name)) {
            Ok(b) => serde_json::from_slice(&b).map_err(io::Error::other),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(T::default()),
            Err(e) => Err(e),
        }
    }

    /// Writes `<name>.tmp` (mode `0600`) and renames it over `<name>`.
    pub fn write_json<T: Serialize>(&self, name: &str, v: &T) -> io::Result<()> {
        let tmp = self.dir.join(format!("{name}.tmp"));
        let bytes = serde_json::to_vec_pretty(v).map_err(io::Error::other)?;
        let mut f = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, self.dir.join(name))
    }

    /// A missing file is fine.
    pub fn remove(&self, name: &str) -> io::Result<()> {
        match std::fs::remove_file(self.dir.join(name)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    pub fn mtime(&self, name: &str) -> Option<SystemTime> {
        std::fs::metadata(self.dir.join(name))
            .and_then(|m| m.modified())
            .ok()
    }
}
