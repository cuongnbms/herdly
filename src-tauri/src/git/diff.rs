//! Diff types and a hand-written parser for git's unified and combined diffs.
use super::log::has_parent;
use super::{failed, run, run_bytes, valid_sha, GIT};
use crate::error::{AppError, AppResult};
use crate::files::MAX_TEXT_BYTES;
use crate::transport::Transport;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LineKind {
    Context,
    Add,
    Del,
    Combined,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DiffLine {
    pub kind: LineKind,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    /// Without the one-char marker; a `Combined` line keeps its two marker chars.
    pub text: String,
    pub no_newline: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Hunk {
    /// The whole `@@ … @@ heading` line.
    pub header: String,
    pub old_start: u32,
    pub new_start: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FileDiff {
    pub binary: bool,
    pub old_mode: Option<String>,
    pub new_mode: Option<String>,
    pub rename: Option<String>,
    pub added: u32,
    pub removed: u32,
    pub hunks: Vec<Hunk>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DiffScope {
    Worktree,
    Staged,
    Commit { sha: String },
}

/// `-a[,b]` or `+c[,d]` to its start line.
fn range_start(tok: &str) -> Option<u32> {
    tok.get(1..)?.split(',').next()?.parse().ok()
}

/// A hunk header to (parents, old_start, new_start); `parents` is 1 for `@@`, 2+ for `@@@`.
fn parse_hunk_header(line: &str) -> Option<(usize, u32, u32)> {
    let ats = line.bytes().take_while(|&b| b == b'@').count();
    if ats < 2 || line.as_bytes().get(ats) != Some(&b' ') {
        return None;
    }
    let (mut old, mut new) = (None, None);
    for tok in line[ats..].split_whitespace() {
        if tok.starts_with('@') {
            break;
        }
        match tok.as_bytes()[0] {
            b'-' if old.is_none() => old = Some(range_start(tok)?),
            b'+' => new = Some(range_start(tok)?),
            _ => {}
        }
    }
    Some((ats - 1, old?, new?))
}

/// Expects the patch of a single file (Task 5 always diffs one path).
pub(crate) fn parse_patch(text: &str) -> FileDiff {
    let mut d = FileDiff {
        binary: false,
        old_mode: None,
        new_mode: None,
        rename: None,
        added: 0,
        removed: 0,
        hunks: Vec::new(),
        truncated: false,
    };
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    // Parents of the open hunk, and its running line counters.
    let (mut parents, mut old_no, mut new_no) = (1usize, 0u32, 0u32);
    for line in lines {
        if let Some((p, old_start, new_start)) = parse_hunk_header(line) {
            parents = p;
            old_no = old_start;
            new_no = new_start;
            d.hunks.push(Hunk {
                header: line.to_string(),
                old_start,
                new_start,
                lines: Vec::new(),
            });
            continue;
        }
        let Some(hunk) = d.hunks.last_mut() else {
            if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
                d.binary = true;
            } else if let Some(m) = line.strip_prefix("old mode ") {
                d.old_mode = Some(m.to_string());
            } else if let Some(m) = line.strip_prefix("new mode ") {
                d.new_mode = Some(m.to_string());
            } else if let Some(m) = line.strip_prefix("new file mode ") {
                d.new_mode = Some(m.to_string());
            } else if let Some(m) = line.strip_prefix("deleted file mode ") {
                d.old_mode = Some(m.to_string());
            } else if let Some(f) = line.strip_prefix("rename from ") {
                d.rename = Some(f.to_string());
            }
            continue;
        };
        if line.starts_with('\\') {
            if let Some(last) = hunk.lines.last_mut() {
                last.no_newline = true;
            }
            continue;
        }
        let mut push = |kind, old_no, new_no, text: &str| {
            hunk.lines.push(DiffLine {
                kind,
                old_no,
                new_no,
                text: text.to_string(),
                no_newline: false,
            })
        };
        if parents > 1 {
            let markers = line.get(..parents).unwrap_or(line);
            let numbered = !markers.contains('-');
            push(LineKind::Combined, None, numbered.then_some(new_no), line);
            if numbered {
                new_no += 1;
            }
            continue;
        }
        match line.as_bytes().first() {
            Some(b'+') => {
                push(LineKind::Add, None, Some(new_no), &line[1..]);
                new_no += 1;
                d.added += 1;
            }
            Some(b'-') => {
                push(LineKind::Del, Some(old_no), None, &line[1..]);
                old_no += 1;
                d.removed += 1;
            }
            Some(b' ') | None => {
                push(
                    LineKind::Context,
                    Some(old_no),
                    Some(new_no),
                    line.get(1..).unwrap_or(""),
                );
                old_no += 1;
                new_no += 1;
            }
            Some(_) => {}
        }
    }
    d
}

/// One file's diff in one scope. The patch is cut on a line at `MAX_TEXT_BYTES`; the counts
/// come from `--numstat`, so they stay true for a cut diff.
pub async fn git_diff(
    t: &dyn Transport,
    root: &str,
    path: &str,
    orig_path: Option<&str>,
    scope: &DiffScope,
    untracked: bool,
) -> AppResult<FileDiff> {
    // (git subcommand and flags, revision arguments, whether exit 1 means "differs")
    let (cmd, revs, no_index): (&str, Vec<String>, bool) = match scope {
        _ if untracked && matches!(scope, DiffScope::Worktree) => {
            ("diff --no-index", Vec::new(), true)
        }
        DiffScope::Worktree => ("diff -M", Vec::new(), false),
        DiffScope::Staged => ("diff --cached -M", Vec::new(), false),
        DiffScope::Commit { sha } => {
            if !valid_sha(sha) {
                return Err(AppError::new("invalid", "not a commit id"));
            }
            if has_parent(t, root, sha).await? {
                ("diff -M", vec![format!("{sha}^"), sha.clone()], false)
            } else {
                (
                    "diff-tree -M --root --no-commit-id",
                    vec![sha.clone()],
                    false,
                )
            }
        }
    };
    let mut args: Vec<&str> = revs.iter().map(String::as_str).collect();
    args.push("--");
    if no_index {
        args.push("/dev/null");
    } else if let Some(orig) = orig_path {
        args.push(orig);
    }
    args.push(path);

    // The numstat run is the error gate; it is not piped, so its status is git's.
    let stat = run(t, root, &format!("{GIT} {cmd} --numstat \"$@\""), &args).await?;
    if stat.status != 0 && !(no_index && stat.status == 1) {
        return Err(failed(&stat));
    }

    // One byte over the limit tells "exactly the limit" from "more". The patch is read as raw
    // bytes: a lossy decode would change the length at a cut multi-byte character.
    let n = (MAX_TEXT_BYTES + 1).to_string();
    let mut patch_args = vec![n.as_str()];
    patch_args.extend(&args);
    let script = format!("n=$1; shift; {GIT} {cmd} -p \"$@\" | head -c \"$n\"");
    let o = run_bytes(t, root, &script, &patch_args).await?;
    let mut bytes = o.stdout.as_slice();
    let truncated = bytes.len() > MAX_TEXT_BYTES;
    if truncated {
        bytes = &bytes[..MAX_TEXT_BYTES];
        bytes = match bytes.iter().rposition(|&b| b == b'\n') {
            Some(i) => &bytes[..=i],
            None => &[],
        };
    }
    let mut d = parse_patch(&String::from_utf8_lossy(bytes));
    d.truncated = truncated;
    if let Some(line) = stat.stdout.lines().next() {
        let mut f = line.splitn(3, '\t');
        match (f.next(), f.next()) {
            (Some("-"), Some("-")) => d.binary = true,
            (Some(a), Some(r)) => {
                if let (Ok(a), Ok(r)) = (a.parse(), r.parse()) {
                    d.added = a;
                    d.removed = r;
                }
            }
            _ => {}
        }
    }
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::git::testutil::{git, git_out, repo};
    use crate::transport::local::LocalTransport;
    use std::path::Path;

    async fn diff(
        dir: &Path,
        path: &str,
        orig: Option<&str>,
        scope: DiffScope,
        untracked: bool,
    ) -> FileDiff {
        git_diff(
            &LocalTransport,
            &dir.to_string_lossy(),
            path,
            orig,
            &scope,
            untracked,
        )
        .await
        .unwrap()
    }
    fn texts(d: &FileDiff) -> Vec<(LineKind, String)> {
        d.hunks
            .iter()
            .flat_map(|h| h.lines.iter().map(|l| (l.kind, l.text.clone())))
            .collect()
    }

    #[tokio::test]
    async fn worktree_staged_and_untracked_scopes() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        repo(&dir);
        std::fs::write(dir.join("a.txt"), "staged\n").unwrap();
        git(&dir, &["add", "a.txt"]);
        std::fs::write(dir.join("a.txt"), "staged\nthen edited\n").unwrap();
        std::fs::write(dir.join("tệp mới.txt"), "x\ny\n").unwrap();
        let w = diff(&dir, "a.txt", None, DiffScope::Worktree, false).await;
        assert_eq!(
            texts(&w),
            vec![
                (LineKind::Context, "staged".into()),
                (LineKind::Add, "then edited".into())
            ]
        );
        let s = diff(&dir, "a.txt", None, DiffScope::Staged, false).await;
        assert_eq!((s.added, s.removed), (1, 1));
        assert!(
            s.hunks[0].lines[0].no_newline,
            "init wrote `a` with no newline"
        );
        let u = diff(&dir, "tệp mới.txt", None, DiffScope::Worktree, true).await;
        assert_eq!(
            (u.added, u.removed, u.new_mode.as_deref()),
            (2, 0, Some("100644"))
        );
    }

    #[tokio::test]
    async fn a_staged_rename_and_a_commit_diff_against_the_first_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        repo(&dir);
        git(&dir, &["mv", "a.txt", "b.txt"]);
        let r = diff(&dir, "b.txt", Some("a.txt"), DiffScope::Staged, false).await;
        assert_eq!((r.rename.as_deref(), r.hunks.len()), (Some("a.txt"), 0));
        git(&dir, &["commit", "-q", "-m", "rename"]);
        git(&dir, &["checkout", "-q", "-b", "side"]);
        std::fs::write(dir.join("side.txt"), "s\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "side"]);
        git(&dir, &["checkout", "-q", "main"]);
        git(&dir, &["merge", "-q", "--no-ff", "-m", "merge", "side"]);
        let sha = git_out(&dir, &["rev-parse", "HEAD"]).trim().to_string();
        let m = diff(&dir, "side.txt", None, DiffScope::Commit { sha }, false).await;
        assert_eq!(texts(&m), vec![(LineKind::Add, "s".into())]);
    }

    #[tokio::test]
    async fn the_root_commit_binary_and_mode_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        repo(&dir);
        let root = git_out(&dir, &["rev-list", "--max-parents=0", "HEAD"])
            .trim()
            .to_string();
        let d = diff(&dir, "a.txt", None, DiffScope::Commit { sha: root }, false).await;
        assert_eq!(d.added, 1);
        std::fs::write(dir.join("b.bin"), [0u8, 1, 2, 0, 255]).unwrap();
        git(&dir, &["add", "b.bin"]);
        assert!(
            diff(&dir, "b.bin", None, DiffScope::Staged, false)
                .await
                .binary
        );
        git(&dir, &["update-index", "--chmod=+x", "a.txt"]);
        let m = diff(&dir, "a.txt", None, DiffScope::Staged, false).await;
        assert_eq!(
            (m.old_mode.as_deref(), m.new_mode.as_deref(), m.hunks.len()),
            (Some("100644"), Some("100755"), 0)
        );
    }

    #[tokio::test]
    async fn cuts_a_huge_diff_on_a_line_and_keeps_the_true_counts() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        repo(&dir);
        let line = "x".repeat(99);
        let big: String = (0..30_000).map(|_| format!("{line}\n")).collect();
        std::fs::write(dir.join("big.txt"), &big).unwrap();
        let d = diff(&dir, "big.txt", None, DiffScope::Worktree, true).await;
        assert!(d.truncated);
        assert_eq!(d.added, 30_000);
        let shown: usize = d.hunks.iter().map(|h| h.lines.len()).sum();
        assert!(shown < 30_000 && shown > 15_000, "{shown}");
        assert!(d
            .hunks
            .iter()
            .flat_map(|h| &h.lines)
            .all(|l| l.text == line));
    }

    #[tokio::test]
    async fn cuts_multibyte_text_on_a_line_too() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        repo(&dir);
        let line = "ệ".repeat(33);
        let big: String = (0..30_000).map(|_| format!("{line}\n")).collect();
        std::fs::write(dir.join("big.txt"), &big).unwrap();
        let d = diff(&dir, "big.txt", None, DiffScope::Worktree, true).await;
        assert!(d.truncated);
        assert!(d
            .hunks
            .iter()
            .flat_map(|h| &h.lines)
            .all(|l| l.text == line));
    }

    #[tokio::test]
    async fn refuses_a_bad_sha_and_reports_a_vanished_one() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        repo(&dir);
        let d = dir.to_string_lossy();
        let bad = DiffScope::Commit {
            sha: "HEAD~1".into(),
        };
        let e = git_diff(&LocalTransport, &d, "a.txt", None, &bad, false)
            .await
            .err()
            .unwrap();
        assert_eq!(e.code, "invalid");
        let gone = DiffScope::Commit {
            sha: "deadbeef".into(),
        };
        let e = git_diff(&LocalTransport, &d, "a.txt", None, &gone, false)
            .await
            .err()
            .unwrap();
        assert_eq!(e.code, "git");
    }

    fn kinds(d: &FileDiff) -> Vec<(LineKind, Option<u32>, Option<u32>, &str)> {
        d.hunks
            .iter()
            .flat_map(|h| {
                h.lines
                    .iter()
                    .map(|l| (l.kind, l.old_no, l.new_no, l.text.as_str()))
            })
            .collect()
    }

    #[test]
    fn numbers_context_added_and_deleted_lines() {
        let p = "diff --git a/x.rs b/x.rs\nindex 1..2 100644\n--- a/x.rs\n+++ b/x.rs\n@@ -10,3 +10,4 @@ fn main() {\n a\n-b\n+B\n+@@ not a header\n c\n";
        let d = parse_patch(p);
        assert_eq!(d.hunks.len(), 1);
        assert_eq!((d.hunks[0].old_start, d.hunks[0].new_start), (10, 10));
        assert_eq!(d.hunks[0].header, "@@ -10,3 +10,4 @@ fn main() {");
        assert_eq!(
            kinds(&d),
            vec![
                (LineKind::Context, Some(10), Some(10), "a"),
                (LineKind::Del, Some(11), None, "b"),
                (LineKind::Add, None, Some(11), "B"),
                (LineKind::Add, None, Some(12), "@@ not a header"),
                (LineKind::Context, Some(12), Some(13), "c"),
            ]
        );
        assert_eq!(
            (d.added, d.removed, d.binary, d.truncated),
            (2, 1, false, false)
        );
    }

    #[test]
    fn reads_several_hunks_and_single_line_ranges() {
        let p = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -20,0 +21,2 @@\n+c\n+d\n";
        let d = parse_patch(p);
        assert_eq!(
            d.hunks
                .iter()
                .map(|h| (h.old_start, h.new_start, h.lines.len()))
                .collect::<Vec<_>>(),
            [(1, 1, 2), (20, 21, 2)]
        );
        assert_eq!(kinds(&d)[2], (LineKind::Add, None, Some(21), "c"));
    }

    #[test]
    fn marks_a_missing_newline_on_the_line_before() {
        let p = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n";
        let d = parse_patch(p);
        let flags: Vec<bool> = d.hunks[0].lines.iter().map(|l| l.no_newline).collect();
        assert_eq!(flags, [true, true]);
        assert_eq!(d.hunks[0].lines.len(), 2);
    }

    #[test]
    fn reads_binary_modes_and_renames() {
        let d = parse_patch("diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n");
        assert!(d.binary && d.hunks.is_empty());
        let d = parse_patch("diff --git a/s.sh b/s.sh\nold mode 100644\nnew mode 100755\n");
        assert_eq!(
            (d.old_mode.as_deref(), d.new_mode.as_deref()),
            (Some("100644"), Some("100755"))
        );
        let d = parse_patch(
            "diff --git a/a b/b\nsimilarity index 100%\nrename from old/a.rs\nrename to new/b.rs\n",
        );
        assert_eq!(d.rename.as_deref(), Some("old/a.rs"));
        let d = parse_patch(
            "diff --git a/n b/n\nnew file mode 100755\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+x\n",
        );
        assert_eq!(
            (d.old_mode, d.new_mode.as_deref(), d.added),
            (None, Some("100755"), 1)
        );
        let d = parse_patch("diff --git a/g b/g\ndeleted file mode 100644\n--- a/g\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n");
        assert_eq!(
            (d.old_mode.as_deref(), d.new_mode, d.removed),
            (Some("100644"), None, 1)
        );
    }

    #[test]
    fn keeps_a_combined_diffs_two_markers() {
        let p = "diff --cc a.txt\nindex 1,2..0\n--- a/a.txt\n+++ b/a.txt\n@@@ -1,1 -1,1 +1,5 @@@\n++<<<<<<< HEAD\n +ours\n++=======\n+ theirs\n++>>>>>>> other\n";
        let d = parse_patch(p);
        assert_eq!(d.hunks[0].header, "@@@ -1,1 -1,1 +1,5 @@@");
        assert_eq!(d.hunks[0].new_start, 1);
        assert!(d.hunks[0]
            .lines
            .iter()
            .all(|l| l.kind == LineKind::Combined && l.old_no.is_none()));
        assert_eq!(d.hunks[0].lines[1].text, " +ours");
        assert_eq!(d.hunks[0].lines[1].new_no, Some(2));
    }

    #[test]
    fn keeps_carriage_returns_and_empty_context_lines() {
        let d = parse_patch("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n \n-a\r\n+b\r\n");
        assert_eq!(
            kinds(&d),
            vec![
                (LineKind::Context, Some(1), Some(1), ""),
                (LineKind::Del, Some(2), None, "a\r"),
                (LineKind::Add, None, Some(2), "b\r")
            ]
        );
    }

    #[test]
    fn skips_numbers_for_lines_removed_in_any_column() {
        let p = "diff --cc f\n--- a/f\n+++ b/f\n@@@ -1,5 -1,5 +1,5 @@@\n  a\n--b\n -THEIRS\n +OURS\n  d\n++x\n  e\n";
        let d = parse_patch(p);
        let nos: Vec<Option<u32>> = d.hunks[0].lines.iter().map(|l| l.new_no).collect();
        assert_eq!(
            nos,
            [Some(1), None, None, Some(2), Some(3), Some(4), Some(5)]
        );
    }

    #[test]
    fn deserializes_scopes() {
        let s: DiffScope =
            serde_json::from_str(r#"{"kind":"commit","sha":"abc1234","short":"abc1234"}"#).unwrap();
        assert!(matches!(s, DiffScope::Commit { sha } if sha == "abc1234"));
        assert!(matches!(
            serde_json::from_str::<DiffScope>(r#"{"kind":"staged"}"#).unwrap(),
            DiffScope::Staged
        ));
    }
}
