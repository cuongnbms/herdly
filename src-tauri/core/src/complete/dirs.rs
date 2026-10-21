//! Folders inside a folder on a Machine, for the folder field of the new agent and workspace dialogs.
use crate::error::AppResult;
use crate::transport::{exec, Transport};

const MAX_DIRS: usize = 500;

/// Prints each folder (or symlink to one) in `$1`, dotfolders included; nothing when `$1` is missing.
const SCRIPT: &str = r#"cd "$1" 2>/dev/null || exit 0
for d in * .*; do
  case "$d" in .|..) continue ;; esac
  [ -d "$d" ] && printf '%s\n' "$d"
done"#;

/// `~` or `~/…` becomes a path under `home`; anything else is returned as is.
pub fn expand_home(dir: &str, home: &str) -> String {
    match dir.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            format!("{}{rest}", home.trim_end_matches('/'))
        }
        _ => dir.to_string(),
    }
}

/// Names of the folders in `dir` (which may start with `~`), sorted ignoring case.
pub async fn list_dirs(t: &dyn Transport, home: &str, dir: &str) -> AppResult<Vec<String>> {
    let dir = expand_home(dir, home);
    if !dir.starts_with('/') {
        return Ok(Vec::new());
    }
    let argv = vec![
        "sh".to_string(),
        "-c".into(),
        SCRIPT.into(),
        "sh".into(),
        dir,
    ];
    let o = exec(t, &argv).await?;
    let mut dirs: Vec<String> = o
        .stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    dirs.sort_by_key(|d| d.to_lowercase());
    dirs.truncate(MAX_DIRS);
    Ok(dirs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;

    #[test]
    fn expands_only_a_leading_tilde_segment() {
        assert_eq!(expand_home("~", "/home/u/"), "/home/u");
        assert_eq!(expand_home("~/src", "/home/u"), "/home/u/src");
        assert_eq!(expand_home("~bob/src", "/home/u"), "~bob/src");
        assert_eq!(expand_home("/tmp/~", "/home/u"), "/tmp/~");
    }

    #[tokio::test]
    async fn lists_folders_and_folder_links_but_not_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("my root");
        for d in ["beta", "Alpha", ".hidden", "has space/inner"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        std::fs::write(root.join("file.txt"), "").unwrap();
        std::os::unix::fs::symlink(root.join("beta"), root.join("link")).unwrap();
        let got = list_dirs(
            &LocalTransport,
            "/nonexistent-home",
            &root.to_string_lossy(),
        )
        .await
        .unwrap();
        assert_eq!(got, vec![".hidden", "Alpha", "beta", "has space", "link"]);
    }

    #[tokio::test]
    async fn expands_tilde_against_home() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("proj")).unwrap();
        let home = tmp.path().to_string_lossy().into_owned();
        let got = list_dirs(&LocalTransport, &home, "~").await.unwrap();
        assert_eq!(got, vec!["proj"]);
    }

    #[tokio::test]
    async fn a_missing_or_relative_folder_has_no_folders() {
        for dir in ["/nonexistent/herdr-app", "relative/path"] {
            let got = list_dirs(&LocalTransport, "/nonexistent-home", dir)
                .await
                .unwrap();
            assert!(got.is_empty(), "{dir}: {got:?}");
        }
    }
}
