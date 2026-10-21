//! One folder's entries, relative to a Pane's working directory, for `@../` completion.
use crate::error::AppResult;
use crate::transport::{exec, Transport};

const MAX_ENTRIES: usize = 1000;

/// Prints each entry of `$2` (resolved from `$1`), dotfiles included, folders with a trailing `/`;
/// nothing when either folder is missing.
const SCRIPT: &str = r#"cd "$1" 2>/dev/null && cd "$2" 2>/dev/null || exit 0
for e in * .*; do
  case "$e" in .|..) continue ;; esac
  if [ -d "$e" ]; then printf '%s/\n' "$e"; elif [ -e "$e" ]; then printf '%s\n' "$e"; fi
done"#;

/// Names in `dir` (relative to `cwd`), folders ending in `/`, sorted ignoring case.
/// Lists one level only, so a parent that is the home folder does not scan `~/Library`.
pub async fn list_entries(t: &dyn Transport, cwd: &str, dir: &str) -> AppResult<Vec<String>> {
    let argv = vec![
        "sh".to_string(),
        "-c".into(),
        SCRIPT.into(),
        "sh".into(),
        cwd.to_string(),
        dir.to_string(),
    ];
    let o = exec(t, &argv).await?;
    let mut entries: Vec<String> = o
        .stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    entries.sort_by_key(|e| e.to_lowercase());
    entries.truncate(MAX_ENTRIES);
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;

    #[tokio::test]
    async fn lists_a_parent_folder_with_folders_marked() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("my root");
        for d in ["proj/src", "Other", ".hidden", "has space"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        std::fs::write(root.join("notes.md"), "").unwrap();
        std::fs::write(root.join("Other/a.txt"), "").unwrap();
        let cwd = root.join("proj/src").to_string_lossy().into_owned();

        let got = list_entries(&LocalTransport, &cwd, "../../").await.unwrap();
        assert_eq!(
            got,
            vec![".hidden/", "has space/", "notes.md", "Other/", "proj/"]
        );
        let got = list_entries(&LocalTransport, &cwd, "../../Other/")
            .await
            .unwrap();
        assert_eq!(got, vec!["a.txt"]);
    }

    #[tokio::test]
    async fn a_missing_folder_has_no_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_string_lossy().into_owned();
        for (cwd, dir) in [
            (cwd.as_str(), "../nonexistent-herdr-app/"),
            ("/nonexistent/herdr-app", "../"),
        ] {
            let got = list_entries(&LocalTransport, cwd, dir).await.unwrap();
            assert!(got.is_empty(), "{cwd} {dir}: {got:?}");
        }
    }
}
