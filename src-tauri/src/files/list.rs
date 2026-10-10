use serde::Serialize;

use super::paths::{check_rel, io_error, script_argv};
use super::MAX_DIR_ENTRIES;
use crate::error::{AppError, AppResult};
use crate::transport::{exec_bytes, Transport};

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    /// A symlink to a folder: it expands like a folder.
    DirLink,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Entry {
    pub name: String,
    pub kind: EntryKind,
}

/// Script prologue: `$1` is the root, `$2` the folder below it; ends inside `$2`. Exit 3 when
/// the root is not a folder, 4 when `$2` does not exist, 5 when it is not a folder, 6 when a
/// folder cannot be entered.
macro_rules! enter_folder {
    () => {
        r#"[ -d "$1" ] || exit 3
cd "$1" || exit 6
[ -e "./$2" ] || [ -L "./$2" ] || exit 4
[ -d "./$2" ] || exit 5
cd "./$2" || exit 6
"#
    };
}

/// An unmatched glob yields its own pattern, so entries that do not exist are skipped.
const LIST_SCRIPT: &str = concat!(
    enter_folder!(),
    r#"for e in * .*; do
  case "$e" in .|..) continue;; esac
  case "$e" in *"
"*) continue;; esac
  [ -e "./$e" ] || [ -L "./$e" ] || continue
  if [ -L "./$e" ]; then
    if [ -d "./$e" ]; then k=L; else k=l; fi
  elif [ -d "./$e" ]; then k=d; else k=f; fi
  printf '%s\t%s\n' "$k" "$e"
done"#
);

/// Every name in the folder, each followed by a NUL (names can hold newlines).
const NAMES_SCRIPT: &str = concat!(
    enter_folder!(),
    r#"for e in * .*; do
  case "$e" in .|..) continue;; esac
  [ -e "./$e" ] || [ -L "./$e" ] || continue
  printf '%s\0' "$e"
done"#
);

/// One level of `rel` below `root`: folders (linked ones too) first, then files and symlinks,
/// each sorted case-insensitively. Folders named in `hidden` (Settings › Files) are left out;
/// a linked folder is kept whatever its name, as `complete/files.rs` (`find -type d`) keeps it too.
pub async fn list_dir(
    t: &dyn Transport,
    root: &str,
    rel: &str,
    hidden: &[String],
) -> AppResult<Vec<Entry>> {
    let out = run_in_folder(t, LIST_SCRIPT, root, rel).await?;
    Ok(parse_entries(&out, hidden))
}

/// Every name in `rel` below `root`, hidden and heavy ones included and uncapped: the names an
/// Upload must not reuse. Fails like `list_dir` when `rel` is missing or not a folder.
pub async fn list_names(t: &dyn Transport, root: &str, rel: &str) -> AppResult<Vec<String>> {
    let out = run_in_folder(t, NAMES_SCRIPT, root, rel).await?;
    Ok(out
        .split(|b| *b == 0)
        .filter(|n| !n.is_empty())
        .map(|n| String::from_utf8_lossy(n).into_owned())
        .collect())
}

/// Run a script starting with `enter_folder!` on `root` and `rel`; its stdout on success.
async fn run_in_folder(
    t: &dyn Transport,
    script: &str,
    root: &str,
    rel: &str,
) -> AppResult<Vec<u8>> {
    check_rel(rel)?;
    let out = exec_bytes(t, &script_argv(script, &[root, rel])).await?;
    match out.status {
        0 => Ok(out.stdout),
        3 => Err(not_found(format!("no such folder: {root:?}"))),
        4 => Err(not_found(format!("no such folder: {rel:?}"))),
        5 => Err(not_found(format!("not a folder: {rel:?}"))),
        6 => {
            let msg = out.stderr.trim();
            let msg = if msg.is_empty() {
                format!("cannot open folder: {rel:?}")
            } else {
                msg.to_string()
            };
            Err(AppError::new("io", msg))
        }
        s => Err(io_error(s, &out.stderr)),
    }
}

fn not_found(msg: String) -> AppError {
    AppError::new("not_found", msg)
}

/// The script's `kind<TAB>name` lines, folders named in `hidden` dropped, sorted and capped.
fn parse_entries(stdout: &[u8], hidden: &[String]) -> Vec<Entry> {
    let mut entries: Vec<Entry> = stdout
        .split(|b| *b == b'\n')
        .filter_map(|line| {
            let line = String::from_utf8_lossy(line);
            let (k, name) = line.split_once('\t')?;
            let kind = match k {
                "d" => EntryKind::Dir,
                "l" => EntryKind::Symlink,
                "L" => EntryKind::DirLink,
                "f" => EntryKind::File,
                _ => return None,
            };
            if kind == EntryKind::Dir && hidden.iter().any(|h| *h == name) {
                return None;
            }
            Some(Entry {
                name: name.to_string(),
                kind,
            })
        })
        .collect();
    // The exact name breaks ties between names equal ignoring case, so the order is stable.
    entries.sort_by_cached_key(|e| {
        (
            !matches!(e.kind, EntryKind::Dir | EntryKind::DirLink),
            e.name.to_lowercase(),
            e.name.clone(),
        )
    });
    entries.truncate(MAX_DIR_ENTRIES);
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;

    /// The Files tree's default hidden folders.
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
    async fn lists_one_level_dirs_first_skipping_heavy_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("my root");
        mk(
            &root,
            &[
                "b.md",
                "A.txt",
                "src/x.ts",
                "node_modules/y.js",
                ".git/HEAD",
                "-dash.md",
                "it's.md",
                "build",
            ],
        );
        std::os::unix::fs::symlink("b.md", root.join("link")).unwrap();
        std::os::unix::fs::symlink("src", root.join("srclink")).unwrap();
        std::os::unix::fs::symlink("gone", root.join("dangling")).unwrap();
        let got = list_dir(&LocalTransport, &root.to_string_lossy(), "", &heavy())
            .await
            .unwrap();
        let names: Vec<(&str, &EntryKind)> =
            got.iter().map(|e| (e.name.as_str(), &e.kind)).collect();
        assert_eq!(
            names,
            vec![
                ("src", &EntryKind::Dir),
                ("srclink", &EntryKind::DirLink),
                ("-dash.md", &EntryKind::File),
                ("A.txt", &EntryKind::File),
                ("b.md", &EntryKind::File),
                ("build", &EntryKind::File),
                ("dangling", &EntryKind::Symlink),
                ("it's.md", &EntryKind::File),
                ("link", &EntryKind::Symlink),
            ]
        );
        let sub = list_dir(&LocalTransport, &root.to_string_lossy(), "src", &heavy())
            .await
            .unwrap();
        assert_eq!(
            sub,
            vec![Entry {
                name: "x.ts".into(),
                kind: EntryKind::File
            }]
        );
        let linked = list_dir(
            &LocalTransport,
            &root.to_string_lossy(),
            "srclink",
            &heavy(),
        )
        .await
        .unwrap();
        assert_eq!(linked, sub);
    }

    #[tokio::test]
    async fn lists_heavy_dirs_when_asked() {
        let tmp = tempfile::tempdir().unwrap();
        mk(tmp.path(), &["node_modules/y.js", ".git/HEAD", "src/x.ts"]);
        let r = tmp.path().to_string_lossy().into_owned();
        let got = list_dir(&LocalTransport, &r, "", &[]).await.unwrap();
        let names: Vec<&str> = got.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec![".git", "node_modules", "src"]);
        let inside = list_dir(&LocalTransport, &r, "node_modules", &[])
            .await
            .unwrap();
        assert_eq!(inside[0].name, "y.js");
    }

    #[tokio::test]
    async fn hides_only_the_folders_named() {
        let tmp = tempfile::tempdir().unwrap();
        mk(
            tmp.path(),
            &["node_modules/y.js", "logs/a.log", "src/x.ts", "tmp"],
        );
        let r = tmp.path().to_string_lossy().into_owned();
        let hidden = vec!["logs".to_string(), "tmp".to_string()];
        let got = list_dir(&LocalTransport, &r, "", &hidden).await.unwrap();
        let names: Vec<&str> = got.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["node_modules", "src", "tmp"]);
    }

    #[tokio::test]
    async fn missing_folder_is_not_found_and_escape_is_invalid() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().to_string_lossy().into_owned();
        std::fs::write(tmp.path().join("f"), "x").unwrap();
        let e = list_dir(&LocalTransport, &r, "nope", &heavy())
            .await
            .unwrap_err();
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            ("not_found", "no such folder: \"nope\"")
        );
        let e = list_dir(&LocalTransport, &r, "f", &heavy())
            .await
            .unwrap_err();
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            ("not_found", "not a folder: \"f\"")
        );
        let gone = format!("{r}/gone");
        let e = list_dir(&LocalTransport, &gone, "", &heavy())
            .await
            .unwrap_err();
        assert_eq!(e.code, "not_found");
        assert!(e.message.contains("gone"), "{}", e.message);
        assert_eq!(
            list_dir(&LocalTransport, &r, "../", &heavy())
                .await
                .unwrap_err()
                .code,
            "invalid"
        );
    }

    #[tokio::test]
    async fn hidden_names_are_listed_and_names_with_a_newline_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        mk(root, &[".env", "a\nb", "ok", ".config/x"]);
        let got = list_dir(&LocalTransport, &root.to_string_lossy(), "", &heavy())
            .await
            .unwrap();
        let names: Vec<&str> = got.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec![".config", ".env", "ok"]);
    }

    #[tokio::test]
    async fn an_unreadable_folder_is_an_io_error() {
        let tmp = tempfile::tempdir().unwrap();
        let locked = tmp.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let res = list_dir(
            &LocalTransport,
            &tmp.path().to_string_lossy(),
            "locked",
            &heavy(),
        )
        .await;
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        // root can enter any folder; there is nothing to check then.
        if let Err(e) = res {
            assert_eq!(e.code, "io");
            assert!(!e.message.is_empty());
        }
    }

    #[tokio::test]
    async fn list_names_reports_every_name_unfiltered() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("my root");
        mk(
            &root,
            &[
                "dest/dist/x.js",
                "dest/node_modules/y.js",
                "dest/.git/HEAD",
                "dest/.env",
                "dest/a b",
                "dest/it's \"q\".md",
                "dest/new\nline",
                "dest/-dash",
            ],
        );
        std::os::unix::fs::symlink("gone", root.join("dest/dangling")).unwrap();
        let mut got = list_names(&LocalTransport, &root.to_string_lossy(), "dest")
            .await
            .unwrap();
        got.sort();
        assert_eq!(
            got,
            [
                "-dash",
                ".env",
                ".git",
                "a b",
                "dangling",
                "dist",
                "it's \"q\".md",
                "new\nline",
                "node_modules",
            ]
        );
    }

    #[tokio::test]
    async fn list_names_is_not_capped() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..MAX_DIR_ENTRIES + 3 {
            std::fs::write(tmp.path().join(format!("f{i}")), "").unwrap();
        }
        let got = list_names(&LocalTransport, &tmp.path().to_string_lossy(), "")
            .await
            .unwrap();
        assert_eq!(got.len(), MAX_DIR_ENTRIES + 3);
    }

    #[tokio::test]
    async fn list_names_fails_like_list_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().to_string_lossy().into_owned();
        std::fs::write(tmp.path().join("f"), "x").unwrap();
        let e = list_names(&LocalTransport, &r, "nope").await.unwrap_err();
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            ("not_found", "no such folder: \"nope\"")
        );
        let e = list_names(&LocalTransport, &r, "f").await.unwrap_err();
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            ("not_found", "not a folder: \"f\"")
        );
        let e = list_names(&LocalTransport, &format!("{r}/gone"), "")
            .await
            .unwrap_err();
        assert_eq!(e.code, "not_found");
        assert_eq!(
            list_names(&LocalTransport, &r, "../")
                .await
                .unwrap_err()
                .code,
            "invalid"
        );
    }

    #[test]
    fn names_equal_ignoring_case_sort_by_exact_name() {
        let got = parse_entries(b"f\tb\nf\tB\nf\ta\nd\tZ\nd\tbuild\nf\tA\n", &heavy());
        let names: Vec<&str> = got.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Z", "A", "a", "B", "b"]);
    }
}
