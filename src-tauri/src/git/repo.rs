//! The repository of a folder with every changed entry, for the Git view.
use super::status::{porcelain_records, Record};
use super::{failed, run, GIT};
use crate::error::AppResult;
use crate::transport::Transport;
use serde::Serialize;

/// The Git view lists at most this many entries; the rest only count.
pub const MAX_GIT_ENTRIES: usize = 5000;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GitEntry {
    /// Repository-relative, as git prints it.
    pub path: String,
    pub orig_path: Option<String>,
    /// `git status`'s two columns (`.` = unchanged); untracked is `?` in both.
    pub index: char,
    pub worktree: char,
    pub unmerged: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GitRepo {
    /// `--show-toplevel`.
    pub root: String,
    /// `--show-prefix`: `""` at the top, else ends in `/`.
    pub prefix: String,
    /// The full commit id; None before the first commit.
    pub head: Option<String>,
    /// The branch, or the short commit on a detached HEAD.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// The first `MAX_GIT_ENTRIES` entries, in `git status` order.
    pub entries: Vec<GitEntry>,
    /// How many entries there are in all.
    pub total: u32,
}

fn script() -> String {
    format!(
        "top=$({GIT} rev-parse --show-toplevel 2>/dev/null) || exit 0; \
         prefix=$({GIT} rev-parse --show-prefix) || exit 0; \
         printf '%s\\0%s\\0' \"$top\" \"$prefix\"; \
         cd \"$top\" && exec {GIT} status --porcelain=v2 --branch -z --untracked-files=all"
    )
}

/// The repository containing `dir` with its entries; None outside a repository or for a missing
/// folder.
pub async fn git_repo(t: &dyn Transport, dir: &str) -> AppResult<Option<GitRepo>> {
    let o = match run(t, dir, &script(), &[]).await {
        Ok(o) => o,
        Err(e) if e.code == "not_found" => return Ok(None),
        Err(e) => return Err(e),
    };
    if o.status != 0 {
        return Err(failed(&o));
    }
    Ok(parse_repo(&o.stdout, MAX_GIT_ENTRIES))
}

/// `out` is `top\0prefix\0` followed by porcelain v2 output; empty is not a repository.
pub(crate) fn parse_repo(out: &str, limit: usize) -> Option<GitRepo> {
    let (root, rest) = out.split_once('\0')?;
    let (prefix, rest) = rest.split_once('\0')?;
    let mut r = GitRepo {
        root: root.to_string(),
        prefix: prefix.to_string(),
        head: None,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        entries: Vec::new(),
        total: 0,
    };
    let (mut head, mut oid) = (None, None);
    for rec in porcelain_records(rest) {
        let entry = match rec {
            Record::Branch { key, value } => {
                match key {
                    "oid" => oid = Some(value),
                    "head" => head = Some(value),
                    "upstream" => r.upstream = Some(value.to_string()),
                    "ab" => {
                        for n in value.split(' ') {
                            if let Some(a) = n.strip_prefix('+') {
                                r.ahead = a.parse().unwrap_or(0);
                            } else if let Some(b) = n.strip_prefix('-') {
                                r.behind = b.parse().unwrap_or(0);
                            }
                        }
                    }
                    _ => {}
                }
                continue;
            }
            Record::Untracked { path } => GitEntry {
                path: path.to_string(),
                orig_path: None,
                index: '?',
                worktree: '?',
                unmerged: false,
            },
            Record::Entry {
                xy,
                path,
                orig_path,
                unmerged,
            } => GitEntry {
                path: path.to_string(),
                orig_path: orig_path.map(str::to_string),
                index: xy.chars().next().unwrap_or('.'),
                worktree: xy.chars().nth(1).unwrap_or('.'),
                unmerged,
            },
        };
        r.total += 1;
        if r.entries.len() < limit {
            r.entries.push(entry);
        }
    }
    r.head = oid
        .filter(|o| *o != "(initial)" && !o.is_empty())
        .map(str::to_string);
    r.branch = match (head, oid) {
        (Some("(detached)"), Some(oid)) => Some(oid.chars().take(7).collect()),
        (Some(h), _) if !h.is_empty() => Some(h.to_string()),
        _ => None,
    };
    Some(r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testutil::{git, repo};
    use crate::transport::local::LocalTransport;
    use std::path::Path;

    async fn read(dir: &Path) -> Option<GitRepo> {
        git_repo(&LocalTransport, &dir.to_string_lossy())
            .await
            .unwrap()
    }
    fn e(path: &str, index: char, worktree: char) -> GitEntry {
        GitEntry {
            path: path.into(),
            orig_path: None,
            index,
            worktree,
            unmerged: false,
        }
    }

    #[tokio::test]
    async fn lists_every_kind_of_change_from_the_top_level() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        repo(&dir);
        std::fs::write(dir.join("b.txt"), "b").unwrap();
        std::fs::write(dir.join("gone.txt"), "g").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "two"]);
        std::fs::write(dir.join("a.txt"), "changed").unwrap();
        std::fs::write(dir.join("b.txt"), "staged").unwrap();
        git(&dir, &["add", "b.txt"]);
        std::fs::write(dir.join("b.txt"), "staged then edited").unwrap();
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        std::fs::create_dir_all(dir.join("new dir")).unwrap();
        std::fs::write(dir.join("new dir/tệp.txt"), "n").unwrap();
        git(&dir, &["mv", "a.txt", "moved.txt"]);
        let r = read(&dir).await.unwrap();
        assert_eq!(
            Path::new(&r.root).canonicalize().unwrap(),
            dir.canonicalize().unwrap()
        );
        assert_eq!(r.prefix, "");
        assert_eq!(r.branch.as_deref(), Some("main"));
        assert_eq!(r.head.as_ref().map(|h| h.len()), Some(40));
        let mut entries = r.entries.clone();
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(
            entries,
            vec![
                e("b.txt", 'M', 'M'),
                e("gone.txt", '.', 'D'),
                GitEntry {
                    path: "moved.txt".into(),
                    orig_path: Some("a.txt".into()),
                    index: 'R',
                    worktree: 'M',
                    unmerged: false
                },
                e("new dir/tệp.txt", '?', '?'),
            ]
        );
        assert_eq!(r.total, 4);
    }

    #[tokio::test]
    async fn a_subfolder_root_reports_its_prefix_and_the_whole_repository() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        repo(&dir);
        std::fs::create_dir_all(dir.join("sub/deep")).unwrap();
        std::fs::write(dir.join("top.txt"), "t").unwrap();
        let r = read(&dir.join("sub/deep")).await.unwrap();
        assert_eq!(r.prefix, "sub/deep/");
        assert_eq!(r.entries, vec![e("top.txt", '?', '?')]);
    }

    #[tokio::test]
    async fn a_conflict_is_unmerged() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        repo(&dir);
        git(&dir, &["checkout", "-q", "-b", "other"]);
        std::fs::write(dir.join("a.txt"), "theirs").unwrap();
        git(&dir, &["commit", "-q", "-am", "theirs"]);
        git(&dir, &["checkout", "-q", "main"]);
        std::fs::write(dir.join("a.txt"), "ours").unwrap();
        git(&dir, &["commit", "-q", "-am", "ours"]);
        let _ = std::process::Command::new("git")
            .args(["merge", "-q", "other"])
            .current_dir(&dir)
            .output();
        let r = read(&dir).await.unwrap();
        assert_eq!(
            r.entries,
            vec![GitEntry {
                path: "a.txt".into(),
                orig_path: None,
                index: 'U',
                worktree: 'U',
                unmerged: true
            }]
        );
    }

    #[tokio::test]
    async fn a_repository_without_commits_has_no_head_but_lists_its_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "trunk"]);
        std::fs::write(dir.join("x.txt"), "x").unwrap();
        let r = read(&dir).await.unwrap();
        assert_eq!((r.head, r.branch.as_deref()), (None, Some("trunk")));
        assert_eq!(r.entries, vec![e("x.txt", '?', '?')]);
    }

    #[tokio::test]
    async fn outside_a_repository_and_a_missing_folder_are_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read(tmp.path()).await, None);
        assert_eq!(read(&tmp.path().join("missing")).await, None);
    }

    #[test]
    fn caps_the_entries_and_counts_them_all() {
        let mut out = String::from("/r\0\0# branch.oid (initial)\0# branch.head main\0");
        for i in 0..5 {
            out += &format!("? f{i}\0");
        }
        let r = parse_repo(&out, 2).unwrap();
        assert_eq!(
            r.entries
                .iter()
                .map(|e| e.path.as_str())
                .collect::<Vec<_>>(),
            ["f0", "f1"]
        );
        assert_eq!((r.total, r.head), (5, None));
        assert_eq!(parse_repo("", 2), None);
    }
}
