//! File browsing on a Machine: scripts run over the transport. Upload (`transfer`) and
//! Create/Rename (`edit`) never overwrite; Delete (`edit`) is the one destructive write
//! (ADR-0005, ADR-0006). Write (`edit`) replaces a file's content only after a version check,
//! ADR-0007.

pub mod all;
pub mod cksum;
pub mod edit;
pub mod list;
pub mod paths;
pub mod read;
pub mod transfer;
pub mod watch;
pub mod watch_manager;

pub const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
pub const BINARY_SNIFF_BYTES: usize = 8192;
pub const MAX_LIST_FILES: usize = 50_000;
pub const MAX_DIR_ENTRIES: usize = 5000;

/// A Transport that ignores the script and runs a canned `sh` command instead, to test how
/// a script's output and exit status are read.
#[cfg(test)]
pub(crate) struct Canned(pub &'static str);

#[cfg(test)]
#[async_trait::async_trait]
impl crate::transport::Transport for Canned {
    fn wrap(&self, _argv: &[String], _tty: bool) -> Vec<String> {
        vec!["sh".into(), "-c".into(), self.0.into()]
    }
    async fn local_socket(
        &self,
        _: &crate::transport::SessionEntry,
    ) -> crate::error::AppResult<std::path::PathBuf> {
        unimplemented!()
    }
    async fn release_socket(
        &self,
        _: &crate::transport::SessionEntry,
    ) -> crate::error::AppResult<()> {
        unimplemented!()
    }
}
