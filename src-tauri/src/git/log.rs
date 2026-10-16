//! A repository's history and the files of one commit, for the Git view.
use super::{failed, run, valid_sha, GIT};
use crate::error::{AppError, AppResult};
use crate::transport::Transport;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GitCommit {
    pub sha: String,
    pub short: String,
    pub author: String,
    /// Author time, seconds since the epoch.
    pub time: i64,
    pub parents: u32,
    pub subject: String,
    /// The message after the subject, without trailing newlines.
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GitCommitFile {
    /// The first character of diff-tree's status (`R100` is `R`).
    pub status: char,
    pub path: String,
    pub orig_path: Option<String>,
}

/// `limit` commits of the current branch after `skip`, newest first; empty before the first
/// commit.
pub async fn git_log(
    t: &dyn Transport,
    root: &str,
    skip: u32,
    limit: u32,
) -> AppResult<Vec<GitCommit>> {
    let script = format!(
        "LC_ALL=C {GIT} log --skip=\"$1\" -n \"$2\" \
         --format=%H%x00%h%x00%an%x00%at%x00%P%x00%s%x00%b%x1e"
    );
    let o = run(t, root, &script, &[&skip.to_string(), &limit.to_string()]).await?;
    if o.status == 128 && o.stderr.contains("does not have any commits") {
        return Ok(Vec::new());
    }
    if o.status != 0 {
        return Err(failed(&o));
    }
    Ok(parse_log(&o.stdout))
}

fn parse_log(out: &str) -> Vec<GitCommit> {
    out.split('\x1e')
        .filter_map(|rec| {
            let rec = rec.strip_prefix('\n').unwrap_or(rec);
            let mut f = rec.splitn(7, '\0');
            let (sha, short, author, time, parents, subject, body) = (
                f.next()?,
                f.next()?,
                f.next()?,
                f.next()?,
                f.next()?,
                f.next()?,
                f.next()?,
            );
            Some(GitCommit {
                sha: sha.to_string(),
                short: short.to_string(),
                author: author.to_string(),
                time: time.parse().ok()?,
                parents: parents.split_whitespace().count() as u32,
                subject: subject.to_string(),
                body: body.trim_end_matches('\n').to_string(),
            })
        })
        .collect()
}

/// Whether `sha` has a first parent. With `-q`, exit 1 means no such revision (a root commit's
/// `sha^`); any other failure, such as a repository that is gone, is an error.
pub(crate) async fn has_parent(t: &dyn Transport, root: &str, sha: &str) -> AppResult<bool> {
    if !valid_sha(sha) {
        return Err(AppError::new("invalid", "not a commit id"));
    }
    let script = format!("{GIT} rev-parse --verify -q \"$1^\" >/dev/null");
    let o = run(t, root, &script, &[sha]).await?;
    match o.status {
        0 => Ok(true),
        1 => Ok(false),
        _ => Err(failed(&o)),
    }
}

/// The files `sha` changed against its first parent (the whole tree for a root commit).
pub async fn git_commit_files(
    t: &dyn Transport,
    root: &str,
    sha: &str,
) -> AppResult<Vec<GitCommitFile>> {
    let flags = if has_parent(t, root, sha).await? {
        r#"-r -z -M --no-commit-id --name-status "$1^" "$1""#
    } else {
        r#"-r -z -M --root --no-commit-id --name-status "$1""#
    };
    let o = run(t, root, &format!("{GIT} diff-tree {flags}"), &[sha]).await?;
    if o.status != 0 {
        return Err(failed(&o));
    }
    Ok(parse_commit_files(&o.stdout))
}

fn parse_commit_files(out: &str) -> Vec<GitCommitFile> {
    let mut tokens = out.split('\0').filter(|s| !s.is_empty());
    let mut files = Vec::new();
    while let Some(status) = tokens.next() {
        let Some(c) = status.chars().next() else {
            break;
        };
        let Some(first) = tokens.next() else { break };
        if matches!(c, 'R' | 'C') {
            let Some(path) = tokens.next() else { break };
            files.push(GitCommitFile {
                status: c,
                path: path.to_string(),
                orig_path: Some(first.to_string()),
            });
        } else {
            files.push(GitCommitFile {
                status: c,
                path: first.to_string(),
                orig_path: None,
            });
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testutil::{git, git_out, repo};
    use crate::transport::local::LocalTransport;
    use std::path::Path;

    fn root(dir: &Path) -> String {
        dir.to_string_lossy().into_owned()
    }
    fn f(status: char, path: &str, orig: Option<&str>) -> GitCommitFile {
        GitCommitFile {
            status,
            path: path.into(),
            orig_path: orig.map(Into::into),
        }
    }

    #[tokio::test]
    async fn pages_through_the_log_newest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        repo(&dir);
        for m in ["two", "three\n\nwith a body\nof two lines"] {
            git(&dir, &["commit", "-q", "--allow-empty", "-m", m]);
        }
        let first = git_log(&LocalTransport, &root(&dir), 0, 2).await.unwrap();
        assert_eq!(
            first.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(),
            ["three", "two"]
        );
        assert_eq!(first[0].body, "with a body\nof two lines");
        assert_eq!(
            (
                first[0].author.as_str(),
                first[0].parents,
                first[0].sha.len()
            ),
            ("t", 1, 40)
        );
        assert!(first[0].sha.starts_with(&first[0].short));
        assert!(first[0].time > 1_600_000_000);
        let rest = git_log(&LocalTransport, &root(&dir), 2, 2).await.unwrap();
        assert_eq!(
            rest.iter()
                .map(|c| (c.subject.as_str(), c.parents))
                .collect::<Vec<_>>(),
            [("init", 0)]
        );
    }

    #[tokio::test]
    async fn a_repository_without_commits_has_an_empty_log() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        assert_eq!(
            git_log(&LocalTransport, &root(&dir), 0, 50).await.unwrap(),
            vec![]
        );
    }

    #[tokio::test]
    async fn lists_a_commits_files_including_renames_and_the_root_commit() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        repo(&dir);
        let init = git_out(&dir, &["rev-parse", "HEAD"]).trim().to_string();
        assert_eq!(
            git_commit_files(&LocalTransport, &root(&dir), &init)
                .await
                .unwrap(),
            vec![f('A', "a.txt", None)]
        );
        std::fs::write(dir.join("b c.txt"), "b").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["mv", "a.txt", "tệp.txt"]);
        git(&dir, &["commit", "-q", "-m", "more"]);
        let head = git_out(&dir, &["rev-parse", "HEAD"]).trim().to_string();
        let mut files = git_commit_files(&LocalTransport, &root(&dir), &head)
            .await
            .unwrap();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(
            files,
            vec![f('A', "b c.txt", None), f('R', "tệp.txt", Some("a.txt"))]
        );
    }

    #[tokio::test]
    async fn a_merge_lists_what_it_brought_against_its_first_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        repo(&dir);
        git(&dir, &["checkout", "-q", "-b", "side"]);
        std::fs::write(dir.join("side.txt"), "s").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "side"]);
        git(&dir, &["checkout", "-q", "main"]);
        git(&dir, &["commit", "-q", "--allow-empty", "-m", "main moves"]);
        git(
            &dir,
            &["merge", "-q", "--no-ff", "-m", "merge side", "side"],
        );
        let head = git_out(&dir, &["rev-parse", "HEAD"]).trim().to_string();
        assert_eq!(
            git_commit_files(&LocalTransport, &root(&dir), &head)
                .await
                .unwrap(),
            vec![f('A', "side.txt", None)]
        );
        let log = git_log(&LocalTransport, &root(&dir), 0, 1).await.unwrap();
        assert_eq!(log[0].parents, 2);
    }

    #[tokio::test]
    async fn refuses_a_bad_sha_and_reports_an_unknown_one() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        repo(&dir);
        let e = git_commit_files(&LocalTransport, &root(&dir), "HEAD")
            .await
            .err()
            .unwrap();
        assert_eq!(e.code, "invalid");
        let e = git_commit_files(&LocalTransport, &root(&dir), "deadbeef")
            .await
            .err()
            .unwrap();
        assert_eq!(e.code, "git");
    }
}
