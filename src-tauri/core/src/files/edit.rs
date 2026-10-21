//! Create, Rename, Move and Delete of items below a root (ADR-0006). Create and Rename never replace
//! anything; Delete is the one destructive write, and the UI confirms it first. Write replaces
//! a file's content, but only while the file is still the version the editor loaded (ADR-0007).

use super::cksum::cksum;
use super::paths::{check_rel, io_error, script_argv};
use super::read::{parse_stat, FileVersion};
use super::transfer::{run_piped, TRANSFER_TIMEOUT};
use super::MAX_TEXT_BYTES;
use crate::error::{AppError, AppResult};
use crate::transport::{exec_bytes, exec_input, Transport};

/// `$1` root, `$2` item, `$3` `dir` or `file`. Exit 4 when the name is taken (a dangling link
/// too); missing parent folders are made.
const CREATE_SCRIPT: &str = r#"cd "$1" || exit 3
f="./$2"
if [ -e "$f" ] || [ -L "$f" ]; then exit 4; fi
mkdir -p -- "$(dirname -- "$f")" || exit 1
if [ "$3" = dir ]; then mkdir -- "$f"; else (set -C; : > "$f"); fi"#;

/// `$1` root, `$2` item, `$3` its new path. Exit 5 when the item is missing, 4 when the new
/// name is taken (checked before `mv -n`, and again if the item did not move). Without GNU
/// `-T`, a folder of that name created between the check and the move receives the item
/// inside it: the narrow race ADR-0005 accepts, since nothing is replaced.
const RENAME_SCRIPT: &str = r#"cd "$1" || exit 3
[ -e "./$2" ] || [ -L "./$2" ] || exit 5
if [ -e "./$3" ] || [ -L "./$3" ]; then exit 4; fi
mv -n -- "./$2" "./$3" || exit 1
if [ -e "./$2" ] || [ -L "./$2" ]; then exit 4; fi"#;

/// `$1` root, `$2` item, `$3` the folder it moves into (`.` for the root), `$4` its new path.
/// Exit 6 when that folder is missing; otherwise as RENAME_SCRIPT.
const MOVE_SCRIPT: &str = r#"cd "$1" || exit 3
[ -e "./$2" ] || [ -L "./$2" ] || exit 5
[ -d "./$3" ] || exit 6
if [ -e "./$4" ] || [ -L "./$4" ]; then exit 4; fi
mv -n -- "./$2" "./$4" || exit 1
if [ -e "./$2" ] || [ -L "./$2" ]; then exit 4; fi"#;

/// `$1` root, `$2` item. Exit 5 when it is missing. A linked folder loses only its link: the
/// path never ends with `/`, so `rm` does not follow it.
const DELETE_SCRIPT: &str = r#"cd "$1" || exit 3
[ -e "./$2" ] || [ -L "./$2" ] || exit 5
rm -rf -- "./$2""#;

/// `$1` root, `$2` file, `$3` `check` or `force`, `$4` size, `$5` mtime, `$6` cksum (empty when
/// forced), `$7` the byte length of the new content; stdin is the new content. Exit 3 no such
/// root, 5 no such file (or, forced, no such folder), 6 the file is not the expected version,
/// 7 too many links, 8 not a file, 9 fewer bytes arrived than `$7` (an ssh client that dies
/// mid-transfer closes stdin, and `cat` takes that EOF for the end of the content). Links are
/// followed by hand so the temp file lands beside the real file and the link survives; the
/// temp file takes the old mode and replaces the file with one `mv`.
const WRITE_SCRIPT: &str = r#"cd "$1" || exit 3
f="./$2"
n=0
while [ -L "$f" ]; do
  n=$((n+1)); [ "$n" -le 40 ] || exit 7
  l=$(readlink -- "$f") || exit 1
  case "$l" in /*) f="$l";; *) f="$(dirname -- "$f")/$l";; esac
done
if [ -e "$f" ] && [ ! -f "$f" ]; then exit 8; fi
if [ "$3" = check ]; then
  [ -f "$f" ] || exit 5
  s=$(stat -c '%s %Y' -- "$f" 2>/dev/null || stat -f '%z %m' -- "$f") || exit 1
  [ "$s" = "$4 $5" ] || exit 6
  c=$(cksum < "$f") || exit 1
  [ "${c%% *}" = "$6" ] || exit 6
else
  [ -d "$(dirname -- "$f")" ] || exit 5
fi
t="$(dirname -- "$f")/.$(basename -- "$f").herdr-$$.tmp"
trap 'rm -f -- "$t"' EXIT
cat > "$t" || exit 1
[ "$(wc -c < "$t" | tr -d " ")" = "$7" ] || exit 9
if [ -f "$f" ]; then
  m=$(stat -c '%a' -- "$f" 2>/dev/null || stat -f '%Lp' -- "$f") || exit 1
  chmod "$m" "$t" || exit 1
fi
mv -f -- "$t" "$f" || exit 1
stat -c '%s %Y' -- "$f" 2>/dev/null || stat -f '%z %m' -- "$f""#;

/// An item below the root: not the root itself, and every segment a real name (no empty,
/// `.` or `..` segment, so no trailing `/` either).
fn check_item(rel: &str) -> AppResult<()> {
    check_rel(rel)?;
    if rel.split('/').any(|s| s.is_empty() || s == ".") {
        return Err(AppError::new("invalid", format!("invalid path: {rel:?}")));
    }
    Ok(())
}

/// A name within one folder.
fn check_name(name: &str) -> AppResult<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\0']) {
        return Err(AppError::new("invalid", format!("invalid name: {name:?}")));
    }
    Ok(())
}

fn script_error(status: i32, stderr: &str, root: &str, rel: &str) -> AppError {
    match status {
        3 => AppError::new("not_found", format!("no such folder: {root:?}")),
        4 => AppError::new("invalid", format!("{rel} already exists")),
        5 => AppError::new("not_found", format!("no such file or folder: {rel:?}")),
        _ => io_error(status, stderr),
    }
}

/// The error for WRITE_SCRIPT's exit `status` (non-zero).
fn write_error(status: i32, stderr: &str, root: &str, rel: &str) -> AppError {
    match status {
        3 => AppError::new("not_found", format!("no such folder: {root:?}")),
        5 => AppError::new("not_found", format!("no such file: {rel:?}")),
        6 => AppError::new("conflict", format!("{rel} changed on disk")),
        7 => AppError::new("invalid", format!("too many links: {rel:?}")),
        8 => AppError::new("invalid", format!("{rel} is not a file")),
        9 => AppError::new("io", "incomplete write"),
        s => io_error(s, stderr),
    }
}

/// An empty file, or a folder with `is_dir`, at `rel`; never over anything already there.
pub async fn create(t: &dyn Transport, root: &str, rel: &str, is_dir: bool) -> AppResult<()> {
    check_item(rel)?;
    let kind = if is_dir { "dir" } else { "file" };
    let out = exec_bytes(t, &script_argv(CREATE_SCRIPT, &[root, rel, kind])).await?;
    match out.status {
        0 => Ok(()),
        s => Err(script_error(s, &out.stderr, root, rel)),
    }
}

/// Renames `rel` to `name` in the same folder; returns the new path. Never replaces anything.
pub async fn rename(t: &dyn Transport, root: &str, rel: &str, name: &str) -> AppResult<String> {
    check_item(rel)?;
    check_name(name)?;
    let to = match rel.rsplit_once('/') {
        Some((dir, _)) => format!("{dir}/{name}"),
        None => name.to_string(),
    };
    if to == rel {
        return Ok(to);
    }
    let out = exec_bytes(t, &script_argv(RENAME_SCRIPT, &[root, rel, &to])).await?;
    match out.status {
        0 => Ok(to),
        4 => Err(script_error(4, &out.stderr, root, &to)),
        s => Err(script_error(s, &out.stderr, root, rel)),
    }
}

/// Moves `rel` into the folder `to_dir` (`""` for the root), keeping its name; returns the new
/// path. Never replaces anything, and never moves a folder into itself.
pub async fn move_to(t: &dyn Transport, root: &str, rel: &str, to_dir: &str) -> AppResult<String> {
    check_item(rel)?;
    if !to_dir.is_empty() {
        check_item(to_dir)?;
    }
    if to_dir == rel || to_dir.starts_with(&format!("{rel}/")) {
        return Err(AppError::new(
            "invalid",
            format!("cannot move {rel} into itself"),
        ));
    }
    let name = rel.rsplit_once('/').map_or(rel, |(_, n)| n);
    let to = if to_dir.is_empty() {
        name.to_string()
    } else {
        format!("{to_dir}/{name}")
    };
    if to == rel {
        return Ok(to);
    }
    let dir = if to_dir.is_empty() { "." } else { to_dir };
    let out = exec_bytes(t, &script_argv(MOVE_SCRIPT, &[root, rel, dir, &to])).await?;
    match out.status {
        0 => Ok(to),
        4 => Err(script_error(4, &out.stderr, root, &to)),
        6 => Err(AppError::new(
            "not_found",
            format!("no such folder: {to_dir:?}"),
        )),
        s => Err(script_error(s, &out.stderr, root, rel)),
    }
}

/// Removes `rel` and everything in it. Blocking, with the transfer timeout: a big tree takes
/// longer than a plain exec allows.
pub fn delete(t: &dyn Transport, root: &str, rel: &str) -> AppResult<()> {
    check_item(rel)?;
    let argv = script_argv(DELETE_SCRIPT, &[root, rel]);
    let (exit, _) = run_piped(t, &argv, TRANSFER_TIMEOUT, |stdin, _| {
        drop(stdin);
        Ok(())
    })?;
    match exit.code {
        0 => Ok(()),
        s => Err(script_error(s, &exit.stderr, root, rel)),
    }
}

/// Replaces `rel`'s content with `text` (ADR-0007): only while it is still `expected`, or
/// regardless when `expected` is None (Overwrite / Save again); atomically, through links.
pub async fn write(
    t: &dyn Transport,
    root: &str,
    rel: &str,
    text: &str,
    expected: Option<FileVersion>,
) -> AppResult<FileVersion> {
    check_item(rel)?;
    if text.len() > MAX_TEXT_BYTES {
        return Err(AppError::new("invalid", "text larger than 2 MB"));
    }
    let (mode, size, mtime, sum) = match expected {
        Some(v) => (
            "check",
            v.size.to_string(),
            v.mtime.to_string(),
            v.cksum.to_string(),
        ),
        None => ("force", String::new(), String::new(), String::new()),
    };
    let len = text.len().to_string();
    let argv = script_argv(WRITE_SCRIPT, &[root, rel, mode, &size, &mtime, &sum, &len]);
    let out = exec_input(t, &argv, Some(text.as_bytes())).await?;
    if out.status != 0 {
        return Err(write_error(out.status, &out.stderr, root, rel));
    }
    let stat = out
        .stdout
        .lines()
        .last()
        .and_then(parse_stat)
        .ok_or_else(|| AppError::new("io", "unexpected output from the file script"))?;
    Ok(FileVersion {
        size: stat.size,
        mtime: stat.mtime,
        cksum: cksum(text.as_bytes()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;
    use std::path::Path;

    fn root() -> (tempfile::TempDir, String) {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().join("r o'ot");
        std::fs::create_dir_all(r.join("src")).unwrap();
        let s = r.to_string_lossy().into_owned();
        (tmp, s)
    }

    fn code(e: crate::error::AppError) -> String {
        e.code
    }

    #[tokio::test]
    async fn creates_an_empty_file() {
        let (_t, r) = root();
        create(&LocalTransport, &r, "src/a b.ts", false)
            .await
            .unwrap();
        assert_eq!(std::fs::read(format!("{r}/src/a b.ts")).unwrap(), b"");
    }

    #[tokio::test]
    async fn creates_a_folder() {
        let (_t, r) = root();
        create(&LocalTransport, &r, "src/lib", true).await.unwrap();
        assert!(Path::new(&format!("{r}/src/lib")).is_dir());
    }

    #[tokio::test]
    async fn creates_missing_parent_folders() {
        let (_t, r) = root();
        create(&LocalTransport, &r, "a/b/c.md", false)
            .await
            .unwrap();
        assert!(Path::new(&format!("{r}/a/b/c.md")).is_file());
    }

    #[tokio::test]
    async fn create_never_replaces_a_file() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/src/x"), "keep").unwrap();
        for is_dir in [false, true] {
            let e = create(&LocalTransport, &r, "src/x", is_dir)
                .await
                .unwrap_err();
            assert!(e.message.contains("already exists"), "{e:?}");
        }
        assert_eq!(
            std::fs::read_to_string(format!("{r}/src/x")).unwrap(),
            "keep"
        );
    }

    #[tokio::test]
    async fn create_refuses_a_dangling_symlink_name() {
        let (_t, r) = root();
        std::os::unix::fs::symlink("/nowhere", format!("{r}/link")).unwrap();
        let e = create(&LocalTransport, &r, "link", false)
            .await
            .unwrap_err();
        assert!(e.message.contains("already exists"), "{e:?}");
        assert!(!Path::new("/nowhere").exists());
    }

    #[tokio::test]
    async fn renames_a_file_in_its_folder() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/src/a.ts"), "x").unwrap();
        let to = rename(&LocalTransport, &r, "src/a.ts", "b c.ts")
            .await
            .unwrap();
        assert_eq!(to, "src/b c.ts");
        assert!(!Path::new(&format!("{r}/src/a.ts")).exists());
        assert_eq!(
            std::fs::read_to_string(format!("{r}/src/b c.ts")).unwrap(),
            "x"
        );
    }

    #[tokio::test]
    async fn renames_a_folder_at_the_root() {
        let (_t, r) = root();
        let to = rename(&LocalTransport, &r, "src", "lib").await.unwrap();
        assert_eq!(to, "lib");
        assert!(Path::new(&format!("{r}/lib")).is_dir());
    }

    #[tokio::test]
    async fn rename_never_replaces() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/a"), "a").unwrap();
        std::fs::write(format!("{r}/b"), "b").unwrap();
        let e = rename(&LocalTransport, &r, "a", "b").await.unwrap_err();
        assert!(e.message.contains("already exists"), "{e:?}");
        // Nor moves into a folder of that name.
        let e = rename(&LocalTransport, &r, "a", "src").await.unwrap_err();
        assert!(e.message.contains("already exists"), "{e:?}");
        assert_eq!(std::fs::read_to_string(format!("{r}/a")).unwrap(), "a");
        assert_eq!(std::fs::read_to_string(format!("{r}/b")).unwrap(), "b");
        assert!(!Path::new(&format!("{r}/src/a")).exists());
    }

    #[tokio::test]
    async fn rename_of_a_missing_item_is_not_found() {
        let (_t, r) = root();
        let e = rename(&LocalTransport, &r, "nope", "x").await.unwrap_err();
        assert_eq!(code(e), "not_found");
    }

    #[tokio::test]
    async fn rename_rejects_bad_names() {
        let (_t, r) = root();
        for name in ["", ".", "..", "a/b", "a\0b"] {
            let e = rename(&LocalTransport, &r, "src", name).await.unwrap_err();
            assert_eq!(code(e), "invalid", "{name:?}");
        }
    }

    #[tokio::test]
    async fn rename_to_the_same_name_is_a_no_op() {
        let (_t, r) = root();
        assert_eq!(
            rename(&LocalTransport, &r, "src", "src").await.unwrap(),
            "src"
        );
        assert!(Path::new(&format!("{r}/src")).is_dir());
    }

    #[tokio::test]
    async fn moves_a_file_into_a_folder() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/a b.ts"), "x").unwrap();
        let to = move_to(&LocalTransport, &r, "a b.ts", "src").await.unwrap();
        assert_eq!(to, "src/a b.ts");
        assert!(!Path::new(&format!("{r}/a b.ts")).exists());
        assert_eq!(
            std::fs::read_to_string(format!("{r}/src/a b.ts")).unwrap(),
            "x"
        );
    }

    #[tokio::test]
    async fn moves_a_folder_to_the_root() {
        let (_t, r) = root();
        std::fs::create_dir_all(format!("{r}/src/lib/x")).unwrap();
        let to = move_to(&LocalTransport, &r, "src/lib", "").await.unwrap();
        assert_eq!(to, "lib");
        assert!(Path::new(&format!("{r}/lib/x")).is_dir());
        assert!(!Path::new(&format!("{r}/src/lib")).exists());
    }

    #[tokio::test]
    async fn move_never_replaces() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/a"), "new").unwrap();
        std::fs::write(format!("{r}/src/a"), "old").unwrap();
        let e = move_to(&LocalTransport, &r, "a", "src").await.unwrap_err();
        assert!(e.message.contains("src/a already exists"), "{e:?}");
        assert_eq!(std::fs::read_to_string(format!("{r}/a")).unwrap(), "new");
        assert_eq!(
            std::fs::read_to_string(format!("{r}/src/a")).unwrap(),
            "old"
        );
    }

    #[tokio::test]
    async fn move_refuses_a_folder_into_itself_or_below() {
        let (_t, r) = root();
        std::fs::create_dir_all(format!("{r}/src/lib")).unwrap();
        for to_dir in ["src", "src/lib"] {
            let e = move_to(&LocalTransport, &r, "src", to_dir)
                .await
                .unwrap_err();
            assert_eq!(code(e), "invalid", "{to_dir:?}");
        }
        assert!(Path::new(&format!("{r}/src/lib")).is_dir());
    }

    #[tokio::test]
    async fn move_into_its_own_folder_is_a_no_op() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/src/a"), "x").unwrap();
        assert_eq!(
            move_to(&LocalTransport, &r, "src/a", "src").await.unwrap(),
            "src/a"
        );
        assert!(Path::new(&format!("{r}/src/a")).is_file());
    }

    #[tokio::test]
    async fn move_to_a_missing_folder_is_not_found() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/a"), "x").unwrap();
        let e = move_to(&LocalTransport, &r, "a", "nope").await.unwrap_err();
        assert_eq!(code(e), "not_found");
        let e = move_to(&LocalTransport, &r, "gone", "src")
            .await
            .unwrap_err();
        assert_eq!(code(e), "not_found");
        assert!(Path::new(&format!("{r}/a")).is_file());
    }

    #[tokio::test]
    async fn move_rejects_bad_paths() {
        let (_t, r) = root();
        for (rel, to_dir) in [
            ("", "src"),
            ("../a", "src"),
            ("a", "../x"),
            ("a", "src/"),
            ("a", "/tmp"),
        ] {
            let e = move_to(&LocalTransport, &r, rel, to_dir).await.unwrap_err();
            assert_eq!(code(e), "invalid", "{rel:?} -> {to_dir:?}");
        }
    }

    #[test]
    fn deletes_a_file() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/src/a"), "x").unwrap();
        delete(&LocalTransport, &r, "src/a").unwrap();
        assert!(!Path::new(&format!("{r}/src/a")).exists());
        assert!(Path::new(&format!("{r}/src")).is_dir());
    }

    #[test]
    fn deletes_a_folder_with_its_contents() {
        let (_t, r) = root();
        std::fs::create_dir_all(format!("{r}/src/deep/er")).unwrap();
        std::fs::write(format!("{r}/src/deep/er/f"), "x").unwrap();
        delete(&LocalTransport, &r, "src").unwrap();
        assert!(!Path::new(&format!("{r}/src")).exists());
        assert!(Path::new(&r).is_dir());
    }

    #[test]
    fn delete_of_a_linked_folder_removes_only_the_link() {
        let (t, r) = root();
        let target = t.path().join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep"), "x").unwrap();
        std::os::unix::fs::symlink(&target, format!("{r}/link")).unwrap();
        delete(&LocalTransport, &r, "link").unwrap();
        assert!(std::fs::symlink_metadata(format!("{r}/link")).is_err());
        assert!(target.join("keep").exists());
    }

    #[test]
    fn delete_of_a_missing_item_is_not_found() {
        let (_t, r) = root();
        let e = delete(&LocalTransport, &r, "nope").unwrap_err();
        assert_eq!(code(e), "not_found");
    }

    #[tokio::test]
    async fn refuses_the_root_and_unclean_paths() {
        let (_t, r) = root();
        for rel in ["", "src/", "a//b", "./src", "src/.", "../x", "/etc"] {
            let e = delete(&LocalTransport, &r, rel).unwrap_err();
            assert_eq!(code(e), "invalid", "delete {rel:?}");
            let e = rename(&LocalTransport, &r, rel, "y").await.unwrap_err();
            assert_eq!(code(e), "invalid", "rename {rel:?}");
            let e = create(&LocalTransport, &r, rel, false).await.unwrap_err();
            assert_eq!(code(e), "invalid", "create {rel:?}");
        }
        assert!(Path::new(&format!("{r}/src")).is_dir());
    }

    use crate::files::cksum::cksum;
    use crate::files::read::FileVersion;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    fn ver(path: &str) -> FileVersion {
        let m = std::fs::metadata(path).unwrap();
        FileVersion {
            size: m.size(),
            mtime: m.mtime() as u64,
            cksum: cksum(&std::fs::read(path).unwrap()),
        }
    }

    fn temp_left(dir: &str) -> bool {
        std::fs::read_dir(dir)
            .unwrap()
            .any(|e| e.unwrap().file_name().to_string_lossy().contains(".herdr-"))
    }

    #[tokio::test]
    async fn writes_over_the_expected_version_and_keeps_the_mode() {
        let (_t, r) = root();
        let p = format!("{r}/src/a b.txt");
        std::fs::write(&p, "old\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o750)).unwrap();
        let v = write(
            &LocalTransport,
            &r,
            "src/a b.txt",
            "new\r\nline\n",
            Some(ver(&p)),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "new\r\nline\n");
        assert_eq!(
            std::fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o750
        );
        assert_eq!(v, ver(&p));
        assert!(!temp_left(&format!("{r}/src")));
    }

    #[tokio::test]
    async fn a_changed_file_is_a_conflict_and_stays_untouched() {
        let (_t, r) = root();
        let p = format!("{r}/src/a.txt");
        std::fs::write(&p, "old\n").unwrap();
        let mut stale = ver(&p);
        stale.cksum ^= 1;
        let e = write(&LocalTransport, &r, "src/a.txt", "mine\n", Some(stale))
            .await
            .unwrap_err();
        assert_eq!(code(e), "conflict");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "old\n");
        let mut stale = ver(&p);
        stale.mtime -= 5;
        let e = write(&LocalTransport, &r, "src/a.txt", "mine\n", Some(stale))
            .await
            .unwrap_err();
        assert_eq!(code(e), "conflict");
        assert!(!temp_left(&format!("{r}/src")));
    }

    #[tokio::test]
    async fn expected_on_a_removed_file_is_not_found() {
        let (_t, r) = root();
        let v = FileVersion {
            size: 1,
            mtime: 1,
            cksum: 1,
        };
        let e = write(&LocalTransport, &r, "src/gone.txt", "x", Some(v))
            .await
            .unwrap_err();
        assert_eq!(code(e), "not_found");
    }

    #[tokio::test]
    async fn force_overwrites_and_recreates_but_needs_the_folder() {
        let (_t, r) = root();
        let p = format!("{r}/src/a.txt");
        std::fs::write(&p, "theirs\n").unwrap();
        write(&LocalTransport, &r, "src/a.txt", "mine\n", None)
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "mine\n");
        std::fs::remove_file(&p).unwrap();
        let v = write(&LocalTransport, &r, "src/a.txt", "back\n", None)
            .await
            .unwrap();
        assert_eq!(v, ver(&p));
        let e = write(&LocalTransport, &r, "nope/a.txt", "x", None)
            .await
            .unwrap_err();
        assert_eq!(code(e), "not_found");
    }

    #[tokio::test]
    async fn an_interrupted_transfer_leaves_the_file_untouched() {
        // An ssh client that dies mid-save closes the remote stdin: `cat` sees EOF and
        // succeeds, so the script must compare the bytes it got with the length it was sent.
        let (_t, r) = root();
        let p = format!("{r}/src/a.txt");
        std::fs::write(&p, "old content\n").unwrap();
        for (mode, size, mtime, sum) in [
            ("force", String::new(), String::new(), String::new()),
            (
                "check",
                ver(&p).size.to_string(),
                ver(&p).mtime.to_string(),
                ver(&p).cksum.to_string(),
            ),
        ] {
            let argv = script_argv(
                WRITE_SCRIPT,
                &[&r, "src/a.txt", mode, &size, &mtime, &sum, "20"],
            );
            let out = exec_input(&LocalTransport, &argv, Some(b"partial"))
                .await
                .unwrap();
            assert_eq!(out.status, 9, "{mode}");
            let e = write_error(out.status, &out.stderr, &r, "src/a.txt");
            assert_eq!(
                (e.code.as_str(), e.message.as_str()),
                ("io", "incomplete write")
            );
            assert_eq!(std::fs::read_to_string(&p).unwrap(), "old content\n");
            assert!(!temp_left(&format!("{r}/src")));
        }
    }

    #[tokio::test]
    async fn writes_through_a_symlink_and_keeps_the_link() {
        let (_t, r) = root();
        let p = format!("{r}/src/a.txt");
        std::fs::write(&p, "old\n").unwrap();
        std::os::unix::fs::symlink("src/a.txt", format!("{r}/link.txt")).unwrap();
        write(&LocalTransport, &r, "link.txt", "new\n", Some(ver(&p)))
            .await
            .unwrap();
        assert!(std::fs::symlink_metadata(format!("{r}/link.txt"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "new\n");
    }

    #[tokio::test]
    async fn refuses_a_folder_too_much_text_and_unclean_paths() {
        let (_t, r) = root();
        assert_eq!(
            code(
                write(&LocalTransport, &r, "src", "x", None)
                    .await
                    .unwrap_err()
            ),
            "invalid"
        );
        let big = "a".repeat(crate::files::MAX_TEXT_BYTES + 1);
        assert_eq!(
            code(
                write(&LocalTransport, &r, "src/a.txt", &big, None)
                    .await
                    .unwrap_err()
            ),
            "invalid"
        );
        for rel in ["", "../x", "src//a", "./a"] {
            assert_eq!(
                code(
                    write(&LocalTransport, &r, rel, "x", None)
                        .await
                        .unwrap_err()
                ),
                "invalid",
                "{rel:?}"
            );
        }
    }
}
