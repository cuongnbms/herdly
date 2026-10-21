use super::{SessionEntry, Transport};
use crate::error::AppResult;
use async_trait::async_trait;
use std::path::PathBuf;

/// Runs herdr directly on this Mac.
pub struct LocalTransport;

#[async_trait]
impl Transport for LocalTransport {
    fn wrap(&self, argv: &[String], _tty: bool) -> Vec<String> {
        argv.to_vec()
    }
    async fn local_socket(&self, session: &SessionEntry) -> AppResult<PathBuf> {
        Ok(PathBuf::from(&session.socket))
    }
    async fn release_socket(&self, _session: &SessionEntry) -> AppResult<()> {
        Ok(())
    }
}
