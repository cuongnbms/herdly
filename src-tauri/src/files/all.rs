use serde::Serialize;

use super::paths::{io_error, script_argv};
use super::MAX_LIST_FILES;
use crate::complete::files::is_home;
use crate::error::{AppError, AppResult};
use crate::transport::{exec_bytes, Transport};

/// Upper bound on the bytes read back, so a huge tree cannot flood the transport.
const MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
pub struct FileList {
    pub paths: Vec<String>,
    pub capped: bool,
    pub refused: bool,
}

/// `$1` is the root, the rest are `find -name` patterns of the folders to prune. Prints
/// NUL-terminated records: the paths to leave out, an empty record, then the paths to list.
/// Inside a git work tree the index decides (honouring .gitignore), less the tracked files
/// deleted from disk; elsewhere `find` walks the folder, keeping symlinks to files as git
/// does. `rev-parse` succeeds inside `.git` or a bare repository too, so its answer must be
/// `true`. Exit 3 when the root cannot be entered.
/// The patterns stay arguments, never script text: `for` turns them into `-o -name <p>` each
/// and the leading `-o` is shifted off.
fn script() -> String {
    format!(
        r#"cd "$1" || exit 3
shift
if [ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ]; then
  git ls-files -z -d
  printf '\0'
  git ls-files -z -co --exclude-standard
else
  printf '\0'
  if [ $# -gt 0 ]; then
    for n do shift; set -- "$@" -o -name "$n"; done
    shift
    find . \( -type d \( "$@" \) \) -prune -o -type f -print0 -o -type l -exec test -f {{}} \; -print0
  else
    find . -type f -print0 -o -type l -exec test -f {{}} \; -print0
  fi
fi | head -c {MAX_OUTPUT_BYTES}"#
    )
}

/// `name` as a `find -name` pattern that matches only itself.
fn find_literal(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if matches!(c, '\\' | '*' | '?' | '[') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Every file below `root`, `/`-separated and sorted, less those inside a folder named in
/// `hidden` (Settings › Files). The home folder and `/` are refused (`refused: true`) without
/// running anything.
pub async fn list_all(
    t: &dyn Transport,
    home: &str,
    root: &str,
    hidden: &[String],
) -> AppResult<FileList> {
    if is_home(home, root) || root.trim_end_matches('/').is_empty() {
        return Ok(FileList {
            paths: Vec::new(),
            capped: false,
            refused: true,
        });
    }
    let patterns: Vec<String> = hidden.iter().map(|n| find_literal(n)).collect();
    let args: Vec<&str> = std::iter::once(root)
        .chain(patterns.iter().map(String::as_str))
        .collect();
    let out = exec_bytes(t, &script_argv(&script(), &args)).await?;
    match out.status {
        0 => {}
        3 => {
            return Err(AppError::new(
                "not_found",
                format!("no such folder: {root:?}"),
            ))
        }
        s => return Err(io_error(s, &out.stderr)),
    }
    Ok(parse_list(
        &out.stdout,
        hidden,
        MAX_LIST_FILES,
        MAX_OUTPUT_BYTES,
    ))
}

/// Reads the script's output: `capped` when more than `max_files` paths were listed or the
/// output reached `max_bytes` (and so was cut).
fn parse_list(stdout: &[u8], hidden: &[String], max_files: usize, max_bytes: usize) -> FileList {
    let mut records: Vec<&[u8]> = stdout.split(|b| *b == 0).collect();
    // The last piece is empty after a final NUL; otherwise the output was cut mid-record.
    records.pop();
    let (skip, list) = match records.iter().position(|r| r.is_empty()) {
        Some(i) => (&records[..i], &records[i + 1..]),
        None => (&records[..], &records[..0]),
    };
    let skip: std::collections::HashSet<&[u8]> = skip.iter().copied().collect();
    let mut paths: Vec<String> = list
        .iter()
        .filter(|r| !r.is_empty() && !skip.contains(*r))
        .map(|r| String::from_utf8_lossy(r).into_owned())
        .map(|p| p.strip_prefix("./").map(str::to_string).unwrap_or(p))
        // Only folders are skipped: a file named `build` is listed.
        .filter(|p| match p.rsplit_once('/') {
            Some((dirs, _)) => !dirs.split('/').any(|seg| hidden.iter().any(|h| h == seg)),
            None => true,
        })
        .collect();
    paths.sort();
    // An unmerged path is listed once per stage.
    paths.dedup();
    let capped = paths.len() > max_files || stdout.len() >= max_bytes;
    paths.truncate(max_files);
    FileList {
        paths,
        capped,
        refused: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;
    use std::process::Command;

    /// The default hidden folders.
    fn heavy() -> Vec<String> {
        crate::complete::files::SKIP_DIRS
            .iter()
            .map(|n| n.to_string())
            .collect()
    }

    fn mk(root: &std::path::Path, files: &[&str]) {
        for p in files {
            let f = root.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, "x").unwrap();
        }
    }

    #[tokio::test]
    async fn git_repo_respects_gitignore_and_lists_untracked() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().join("repo");
        mk(
            &r,
            &[
                ".gitignore",
                "src/a.ts",
                "out/gen.js",
                "new file.md",
                "node_modules/m.js",
            ],
        );
        std::fs::write(r.join(".gitignore"), "out/\n").unwrap();
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(&r)
            .status()
            .unwrap();
        Command::new("git")
            .args(["add", "src/a.ts", ".gitignore", "-f", "node_modules/m.js"])
            .current_dir(&r)
            .status()
            .unwrap();
        let got = list_all(
            &LocalTransport,
            "/nonexistent-home",
            &r.to_string_lossy(),
            &heavy(),
        )
        .await
        .unwrap();
        assert_eq!(
            got,
            FileList {
                paths: vec![".gitignore".into(), "new file.md".into(), "src/a.ts".into()],
                capped: false,
                refused: false
            }
        );
        // A subfolder root lists paths relative to itself.
        let sub = list_all(
            &LocalTransport,
            "/nonexistent-home",
            &r.join("src").to_string_lossy(),
            &heavy(),
        )
        .await
        .unwrap();
        assert_eq!(sub.paths, vec!["a.ts".to_string()]);
    }

    #[tokio::test]
    async fn plain_folder_uses_find_and_skips_heavy_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().join("plain");
        mk(&r, &["a.md", "target/x", "deep/b.md", "deep/build"]);
        std::os::unix::fs::symlink("a.md", r.join("link.md")).unwrap();
        std::os::unix::fs::symlink("deep", r.join("dirlink")).unwrap();
        std::os::unix::fs::symlink("gone", r.join("dangling")).unwrap();
        let got = list_all(
            &LocalTransport,
            "/nonexistent-home",
            &r.to_string_lossy(),
            &heavy(),
        )
        .await
        .unwrap();
        assert_eq!(
            got.paths,
            vec!["a.md", "deep/b.md", "deep/build", "link.md"]
        );
    }

    #[tokio::test]
    async fn plain_folder_prunes_only_the_folders_named_matched_literally() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().join("plain");
        mk(
            &r,
            &[
                "a.md",
                "node_modules/m.js",
                "logs/x.log",
                "deep/logs/y.log",
                "a b/c.md",
                "$(touch pwned)/d.md",
                "l*/e.md",
                "lx/f.md",
            ],
        );
        let r_s = r.to_string_lossy().into_owned();
        let hidden: Vec<String> = ["logs", "a b", "$(touch pwned)", "l*"]
            .iter()
            .map(|n| n.to_string())
            .collect();
        let got = list_all(&LocalTransport, "/nonexistent-home", &r_s, &hidden)
            .await
            .unwrap();
        assert_eq!(got.paths, vec!["a.md", "lx/f.md", "node_modules/m.js"]);
        assert!(!r.join("pwned").exists());
        let all = list_all(&LocalTransport, "/nonexistent-home", &r_s, &[])
            .await
            .unwrap();
        assert_eq!(all.paths.len(), 8, "{:?}", all.paths);
    }

    #[tokio::test]
    async fn git_repo_leaves_out_the_folders_named() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().join("repo");
        mk(&r, &["src/a.ts", "docs/b.md", "dist/c.js"]);
        git(&r, &["init", "-q"]);
        let hidden = vec!["docs".to_string()];
        let got = list_all(
            &LocalTransport,
            "/nonexistent-home",
            &r.to_string_lossy(),
            &hidden,
        )
        .await
        .unwrap();
        assert_eq!(got.paths, vec!["dist/c.js", "src/a.ts"]);
    }

    #[tokio::test]
    async fn home_and_slash_are_refused() {
        for (home, root) in [("/home/u", "/home/u/"), ("/home/u", "/")] {
            let got = list_all(&LocalTransport, home, root, &heavy())
                .await
                .unwrap();
            assert!(got.refused && got.paths.is_empty(), "{root}");
        }
    }

    #[tokio::test]
    async fn missing_root_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let gone = tmp.path().join("gone");
        let err = list_all(
            &LocalTransport,
            "/nonexistent-home",
            &gone.to_string_lossy(),
            &heavy(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "not_found");
    }

    fn git(r: &std::path::Path, args: &[&str]) {
        let ok = Command::new("git")
            .args([
                "-c",
                "user.email=a@b",
                "-c",
                "user.name=a",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(r)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    #[tokio::test]
    async fn deleted_tracked_files_are_left_out_and_files_named_like_heavy_dirs_kept() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().join("repo");
        mk(&r, &["keep.md", "gone.md", "scripts/build", "dist/out.js"]);
        git(&r, &["init", "-q"]);
        git(&r, &["add", "-f", "."]);
        git(&r, &["commit", "-qm", "init"]);
        std::fs::remove_file(r.join("gone.md")).unwrap();
        let got = list_all(
            &LocalTransport,
            "/nonexistent-home",
            &r.to_string_lossy(),
            &heavy(),
        )
        .await
        .unwrap();
        assert_eq!(got.paths, vec!["keep.md", "scripts/build"]);
    }

    #[tokio::test]
    async fn inside_the_git_folder_is_not_a_work_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().join("repo");
        std::fs::create_dir_all(&r).unwrap();
        git(&r, &["init", "-q"]);
        let got = list_all(
            &LocalTransport,
            "/nonexistent-home",
            &r.join(".git").to_string_lossy(),
            &heavy(),
        )
        .await
        .unwrap();
        assert!(got.paths.contains(&"HEAD".to_string()), "{:?}", got.paths);
    }

    #[test]
    fn parse_caps_the_count_and_notices_a_byte_cut() {
        let out = b"\0c\0a\0b\0a\0";
        let got = parse_list(out, &heavy(), 2, 1 << 20);
        assert_eq!(
            got,
            FileList {
                paths: vec!["a".into(), "b".into()],
                capped: true,
                refused: false
            }
        );
        let got = parse_list(out, &heavy(), 3, 1 << 20);
        assert!(!got.capped);
        // Output that filled the byte limit was cut: the partial last record is dropped.
        let cut = b"\0./a\0./b\0./lon";
        let got = parse_list(cut, &heavy(), 10, cut.len());
        assert_eq!(
            (got.paths, got.capped),
            (vec!["a".into(), "b".into()], true)
        );
    }

    #[test]
    fn parse_leaves_out_the_skipped_paths_and_heavy_folders() {
        let got = parse_list(
            b"x\0\0x\0y\0node_modules/m.js\0a/target/t\0target\0",
            &heavy(),
            10,
            1 << 20,
        );
        assert_eq!(got.paths, vec!["target", "y"]);
    }

    #[tokio::test]
    async fn a_failure_without_stderr_reports_the_exit_status() {
        let e = list_all(&crate::files::Canned("exit 7"), "/h", "/r", &heavy())
            .await
            .unwrap_err();
        assert_eq!((e.code.as_str(), e.message.as_str()), ("io", "exit 7"));
    }
}
