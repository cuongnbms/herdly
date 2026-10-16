//! The folder and git branch a Pane works in, for the Chat lens status line.
use crate::error::AppResult;
use crate::transport::{exec, Transport};
use serde::Serialize;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct GitStatus {
    /// The working directory's last path segment.
    pub folder: String,
    pub path: String,
    /// The branch, or the short commit on a detached HEAD; None outside a repository.
    pub branch: Option<String>,
    /// Uncommitted or untracked changes in the working tree.
    pub dirty: bool,
    /// The branch's upstream, as `origin/main`; None without one.
    pub upstream: Option<String>,
    /// Commits on the branch but not its upstream, and the other way round.
    pub ahead: u32,
    pub behind: u32,
    /// Files with changes in the index, with changes in the working tree (conflicts included),
    /// and untracked; a file staged and then edited again counts in both of the first two.
    pub staged: u32,
    pub modified: u32,
    pub untracked: u32,
    /// How many files have any change.
    pub changed: u32,
    /// The first `MAX_CHANGES` of them, in `git status` order.
    pub changes: Vec<GitChange>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GitChange {
    /// `git status --short`'s two columns: index then working tree, as `M `, ` M` or `??`.
    pub code: String,
    pub path: String,
}

/// Changed files listed by name; the rest only count.
pub const MAX_CHANGES: usize = 15;

/// `git status` in its machine format, NUL-separated so paths come unquoted; nothing outside a
/// repository. `GIT` carries `--no-optional-locks`, which keeps it from taking the index lock an
/// agent may need.
fn script() -> String {
    format!(
        "cd \"$1\" 2>/dev/null || exit 0\nexec {} status --porcelain=v2 --branch -z 2>/dev/null",
        super::GIT
    )
}

pub async fn git_status(t: &dyn Transport, cwd: &str) -> AppResult<GitStatus> {
    let argv = vec![
        "sh".to_string(),
        "-c".into(),
        script(),
        "sh".into(),
        cwd.to_string(),
    ];
    let o = exec(t, &argv).await?;
    Ok(GitStatus {
        folder: folder_name(cwd),
        path: cwd.to_string(),
        ..parse_porcelain_v2(&o.stdout, MAX_CHANGES)
    })
}

/// One NUL-separated record of `git status --porcelain=v2 [--branch] -z`.
#[derive(Debug, PartialEq)]
pub(crate) enum Record<'a> {
    /// `# branch.<key> <value>`.
    Branch {
        key: &'a str,
        value: &'a str,
    },
    /// A changed (`1`), renamed or copied (`2`, with `orig_path`) or unmerged (`u`) entry.
    Entry {
        xy: &'a str,
        path: &'a str,
        orig_path: Option<&'a str>,
        unmerged: bool,
    },
    Untracked {
        path: &'a str,
    },
}

/// Split porcelain v2 `-z` output into records; ignored (`!`) and unknown records are dropped.
pub(crate) fn porcelain_records(out: &str) -> Vec<Record<'_>> {
    let mut v = Vec::new();
    let mut records = out.split('\0');
    while let Some(rec) = records.next() {
        if let Some(h) = rec.strip_prefix("# branch.") {
            let (key, value) = h.split_once(' ').unwrap_or((h, ""));
            v.push(Record::Branch { key, value });
            continue;
        }
        // Fields before the path: ordinary 8, renamed or copied 9 (then the original path as a
        // record of its own), unmerged 10.
        let (path, orig_path, unmerged) = match rec.as_bytes().first() {
            Some(b'1') => (rec.splitn(9, ' ').nth(8), None, false),
            Some(b'2') => (rec.splitn(10, ' ').nth(9), records.next(), false),
            Some(b'u') => (rec.splitn(11, ' ').nth(10), None, true),
            Some(b'?') => {
                if let Some(path) = rec.get(2..) {
                    v.push(Record::Untracked { path });
                }
                continue;
            }
            _ => continue,
        };
        if let Some(path) = path {
            v.push(Record::Entry {
                xy: field(rec, 1),
                path,
                orig_path,
                unmerged,
            });
        }
    }
    v
}

/// Parse `git status --porcelain=v2 [--branch] -z`, listing the first `limit` changes; empty output
/// (no repository) has no branch.
pub(crate) fn parse_porcelain_v2(out: &str, limit: usize) -> GitStatus {
    let mut s = GitStatus::default();
    let (mut head, mut oid) = (None, None);
    for rec in porcelain_records(out) {
        let (xy, path, unmerged) = match rec {
            Record::Branch { key, value } => {
                match key {
                    "oid" => oid = Some(value),
                    "head" => head = Some(value),
                    "upstream" => s.upstream = Some(value.to_string()),
                    "ab" => {
                        for n in value.split(' ') {
                            if let Some(a) = n.strip_prefix('+') {
                                s.ahead = a.parse().unwrap_or(0);
                            } else if let Some(b) = n.strip_prefix('-') {
                                s.behind = b.parse().unwrap_or(0);
                            }
                        }
                    }
                    _ => {}
                }
                continue;
            }
            Record::Entry {
                xy, path, unmerged, ..
            } => (xy, path, unmerged),
            Record::Untracked { path } => {
                s.untracked += 1;
                ("??", path, false)
            }
        };
        let (x, y) = (
            xy.chars().next().unwrap_or('.'),
            xy.chars().nth(1).unwrap_or('.'),
        );
        if xy != "??" {
            if unmerged {
                s.modified += 1;
            } else {
                s.staged += u32::from(x != '.');
                s.modified += u32::from(y != '.');
            }
        }
        s.changed += 1;
        if s.changes.len() < limit {
            let code = if xy == "??" {
                "??".to_string()
            } else {
                [x, y]
                    .iter()
                    .map(|&c| if c == '.' { ' ' } else { c })
                    .collect()
            };
            s.changes.push(GitChange {
                code,
                path: path.to_string(),
            });
        }
    }
    s.branch = match (head, oid) {
        (Some("(detached)"), Some(oid)) => Some(oid.chars().take(7).collect()),
        (Some(head), _) if !head.is_empty() => Some(head.to_string()),
        _ => None,
    };
    s.dirty = s.changed > 0;
    s
}

fn field(rec: &str, i: usize) -> &str {
    rec.split(' ').nth(i).unwrap_or("..")
}

fn folder_name(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches('/');
    match trimmed.rsplit('/').next() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => "/".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testutil::{git, repo};
    use crate::transport::local::LocalTransport;
    use std::path::Path;

    async fn status(dir: &Path) -> GitStatus {
        git_status(&LocalTransport, &dir.to_string_lossy())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_clean_repo_reports_its_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("my repo");
        repo(&dir);
        let s = status(&dir).await;
        assert_eq!(s.folder, "my repo");
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert!(!s.dirty);
        assert_eq!(s.upstream, None);
        assert!(s.changes.is_empty());
    }

    #[tokio::test]
    async fn changes_and_untracked_files_make_it_dirty() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        repo(&dir);
        std::fs::write(dir.join("new.txt"), "n").unwrap();
        assert!(status(&dir).await.dirty);
    }

    #[tokio::test]
    async fn counts_staged_modified_and_untracked_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        repo(&dir);
        std::fs::write(dir.join("b.txt"), "b").unwrap();
        git(&dir, &["add", "b.txt"]);
        std::fs::write(dir.join("a.txt"), "changed").unwrap();
        std::fs::write(dir.join("new file.txt"), "n").unwrap();
        let s = status(&dir).await;
        assert_eq!((s.staged, s.modified, s.untracked, s.changed), (1, 1, 1, 3));
        let mut changes: Vec<(String, String)> =
            s.changes.into_iter().map(|c| (c.code, c.path)).collect();
        changes.sort();
        assert_eq!(
            changes,
            [
                (" M".to_string(), "a.txt".to_string()),
                ("??".to_string(), "new file.txt".to_string()),
                ("A ".to_string(), "b.txt".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn reports_ahead_and_behind_its_upstream() {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin");
        repo(&origin);
        let clone = tmp.path().join("clone");
        git(
            tmp.path(),
            &[
                "clone",
                "-q",
                &origin.to_string_lossy(),
                &clone.to_string_lossy(),
            ],
        );
        let s = status(&clone).await;
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (0, 0));
        git(&origin, &["commit", "-q", "--allow-empty", "-m", "theirs"]);
        git(&clone, &["fetch", "-q"]);
        git(&clone, &["commit", "-q", "--allow-empty", "-m", "a"]);
        git(&clone, &["commit", "-q", "--allow-empty", "-m", "b"]);
        let s = status(&clone).await;
        assert_eq!((s.ahead, s.behind), (2, 1));
        assert!(!s.dirty);
    }

    #[tokio::test]
    async fn a_detached_head_reports_the_short_commit() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        repo(&dir);
        git(&dir, &["checkout", "-q", "--detach"]);
        let b = status(&dir).await.branch.unwrap();
        assert!(
            b.len() >= 7 && b.chars().all(|c| c.is_ascii_hexdigit()),
            "{b}"
        );
    }

    #[tokio::test]
    async fn a_repo_without_commits_reports_its_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "trunk"]);
        assert_eq!(status(&dir).await.branch.as_deref(), Some("trunk"));
    }

    #[tokio::test]
    async fn outside_a_repo_there_is_only_the_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("plain");
        std::fs::create_dir_all(&dir).unwrap();
        let s = status(&dir).await;
        assert_eq!(s.folder, "plain");
        assert_eq!(s.branch, None);
        assert!(!s.dirty);
    }

    #[tokio::test]
    async fn a_missing_folder_has_no_branch() {
        let s = git_status(&LocalTransport, "/nonexistent/herdr-app/")
            .await
            .unwrap();
        assert_eq!(s.folder, "herdr-app");
        assert_eq!(s.branch, None);
    }

    #[test]
    fn parses_renames_conflicts_and_caps_the_list() {
        let mut out = String::from("# branch.oid abc\0# branch.head main\0");
        out += "2 R. N... 100644 100644 100644 h1 h2 R100 new.rs\0old.rs\0";
        out += "u UU N... 100644 100644 100644 100644 h1 h2 h3 both.rs\0";
        for i in 0..20 {
            out += &format!("? u{i}\0");
        }
        let s = parse_porcelain_v2(&out, MAX_CHANGES);
        assert_eq!(
            (s.staged, s.modified, s.untracked, s.changed),
            (1, 1, 20, 22)
        );
        assert_eq!(s.changes.len(), MAX_CHANGES);
        assert_eq!(
            s.changes[0],
            GitChange {
                code: "R ".into(),
                path: "new.rs".into()
            }
        );
        assert_eq!(
            s.changes[1],
            GitChange {
                code: "UU".into(),
                path: "both.rs".into()
            }
        );
        assert_eq!(s.changes[2].path, "u0");
        assert_eq!(s.upstream, None);
    }

    #[test]
    fn parses_without_branch_headers_and_skips_rename_origins() {
        let out = "2 R. N... 100644 100644 100644 h1 h2 R100 new.rs\0old.rs\0? u0\0? u1\0";
        let s = parse_porcelain_v2(out, usize::MAX);
        assert_eq!((s.changed, s.branch), (3, None));
        let paths: Vec<&str> = s.changes.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(paths, ["new.rs", "u0", "u1"]);
    }

    #[test]
    fn records_split_branch_headers_entries_and_untracked() {
        let mut out = String::from("# branch.oid abc\0# branch.head main\0");
        out += "1 .M N... 100644 100644 100644 h1 h2 a b.rs\0";
        out += "2 R. N... 100644 100644 100644 h1 h2 R100 new name.rs\0old.rs\0";
        out += "u UU N... 100644 100644 100644 100644 h1 h2 h3 both.rs\0";
        out += "? tệp mới.txt\0! ignored\0";
        assert_eq!(
            porcelain_records(&out),
            vec![
                Record::Branch {
                    key: "oid",
                    value: "abc"
                },
                Record::Branch {
                    key: "head",
                    value: "main"
                },
                Record::Entry {
                    xy: ".M",
                    path: "a b.rs",
                    orig_path: None,
                    unmerged: false
                },
                Record::Entry {
                    xy: "R.",
                    path: "new name.rs",
                    orig_path: Some("old.rs"),
                    unmerged: false
                },
                Record::Entry {
                    xy: "UU",
                    path: "both.rs",
                    orig_path: None,
                    unmerged: true
                },
                Record::Untracked {
                    path: "tệp mới.txt"
                },
            ]
        );
    }

    #[test]
    fn folder_names() {
        assert_eq!(folder_name("/a/b"), "b");
        assert_eq!(folder_name("/a/b/"), "b");
        assert_eq!(folder_name("/"), "/");
        assert_eq!(folder_name("~"), "~");
    }
}
