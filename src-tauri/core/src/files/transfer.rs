//! Upload and Download naming and source validation. Nothing is ever overwritten: a clash
//! gets the first free Finder-style name (ADR-0005).

use std::collections::HashSet;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, ChildStdout, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};
use crate::files::paths::{check_rel, io_error, script_argv};
use crate::transport::{sh_quote, Transport};

/// Hard limit for one transfer.
pub const TRANSFER_TIMEOUT: Duration = Duration::from_secs(600);

/// One item dropped from Finder, validated by `check_sources`.
#[derive(Debug, Clone, PartialEq)]
pub struct Source {
    pub path: PathBuf,
    pub name: String,
    /// A real folder. A symlink to a folder is not one: it is copied as a link.
    pub is_dir: bool,
}

/// The `n`-th Finder-style variant of `name`: 0 is `name` itself, then `stem (n).ext`.
/// Folders and dotfiles (`.env`) have no extension; only the last dot splits (`a.tar (1).gz`).
pub fn candidate(name: &str, is_dir: bool, n: usize) -> String {
    if n == 0 {
        return name.to_string();
    }
    let split = if is_dir {
        None
    } else {
        name.rfind('.').filter(|&i| i > 0)
    };
    match split {
        Some(i) => format!("{} ({n}){}", &name[..i], &name[i..]),
        None => format!("{name} ({n})"),
    }
}

/// The first variant of `name` not in `taken` (lowercased names, case-insensitive volumes).
/// Records the pick, lowercased, so later items of the same batch skip it.
pub fn unique_name(taken: &mut HashSet<String>, name: &str, is_dir: bool) -> String {
    let mut n = 0;
    loop {
        let c = candidate(name, is_dir, n);
        if taken.insert(c.to_lowercase()) {
            return c;
        }
        n += 1;
    }
}

/// A `taken` set for `unique_name` from existing names.
pub fn taken_set<'a>(names: impl IntoIterator<Item = &'a str>) -> HashSet<String> {
    names.into_iter().map(str::to_lowercase).collect()
}

/// Validate the absolute paths the webview reports for a Finder drop.
pub fn check_sources(paths: &[String]) -> AppResult<Vec<Source>> {
    if paths.is_empty() {
        return Err(AppError::new("invalid", "nothing to upload"));
    }
    paths
        .iter()
        .map(|p| {
            if !p.starts_with('/') || p.contains('\0') || p.contains('\n') {
                return Err(AppError::new(
                    "invalid",
                    format!("not an absolute path: {p:?}"),
                ));
            }
            let path = PathBuf::from(p);
            let ft = match fs::symlink_metadata(&path) {
                Ok(m) => m.file_type(),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Err(AppError::new("not_found", format!("{p}: no such file")))
                }
                Err(e) => return Err(AppError::new("io", format!("{p}: {e}"))),
            };
            if !(ft.is_file() || ft.is_dir() || ft.is_symlink()) {
                return Err(AppError::new(
                    "invalid",
                    format!("{p}: not a file, folder or symlink"),
                ));
            }
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| AppError::new("invalid", format!("{p}: no usable file name")))?
                .to_string();
            Ok(Source {
                path,
                name,
                is_dir: ft.is_dir(),
            })
        })
        .collect()
}

/// `rel` under the absolute `root` ("" is the root itself).
pub fn join_abs(root: &str, rel: &str) -> String {
    if rel.is_empty() {
        root.to_string()
    } else if root.ends_with('/') {
        format!("{root}{rel}")
    } else {
        format!("{root}/{rel}")
    }
}

/// How a spawned transfer command ended.
#[derive(Debug)]
pub struct Exit {
    pub code: i32,
    pub stderr: String,
}

/// Run `argv` on the Machine with piped stdio and `io` on its stdin/stdout in a separate thread,
/// while this thread waits for the child and, at `timeout`, stops its whole process group (SIGTERM,
/// then SIGKILL after a short grace), which closes the pipes and so unblocks `io`.
/// `io` must drop stdin to signal EOF. Returns the child's exit and `io`'s own result.
pub fn run_piped<T: Send + 'static>(
    t: &dyn Transport,
    argv: &[String],
    timeout: Duration,
    io: impl FnOnce(ChildStdin, ChildStdout) -> AppResult<T> + Send + 'static,
) -> AppResult<(Exit, AppResult<T>)> {
    let full = t.wrap(argv, false);
    let (prog, args) = full
        .split_first()
        .ok_or_else(|| AppError::new("invalid", "empty command"))?;
    let mut child = Command::new(prog)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| AppError::new("io", format!("cannot start {prog}: {e}")))?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    // Drain stderr concurrently so a chatty child cannot block on a full pipe.
    let err_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    });
    let io_thread = thread::spawn(move || io(stdin, stdout));

    let pgid = child.id() as libc::pid_t;
    let deadline = Instant::now() + timeout;
    let mut wait_err = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => {
                stop_group(&mut child, pgid);
                break None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(e) => {
                stop_group(&mut child, pgid);
                wait_err = Some(AppError::new("io", e.to_string()));
                break None;
            }
        }
    };
    // The child is gone, so its pipes are closed and both threads finish.
    let io_res = io_thread
        .join()
        .unwrap_or_else(|_| Err(AppError::new("io", "transfer thread panicked")));
    let stderr = err_thread.join().unwrap_or_default().trim().to_string();
    if let Some(e) = wait_err {
        return Err(e);
    }
    match status {
        None => Err(AppError::new(
            "timeout",
            format!("transfer timed out after {}s", timeout.as_secs()),
        )),
        Some(s) => Ok((
            Exit {
                code: s.code().unwrap_or(-1),
                stderr,
            },
            io_res,
        )),
    }
}

/// Stop the child's whole process group (a shell's grandchildren keep the pipes open): SIGTERM,
/// up to 500 ms grace, then SIGKILL; always reaps the child.
fn stop_group(child: &mut std::process::Child, pgid: libc::pid_t) {
    // SAFETY: killpg only signals the group we created for this child.
    unsafe { libc::killpg(pgid, libc::SIGTERM) };
    let grace = Instant::now() + Duration::from_millis(500);
    while Instant::now() < grace && !matches!(child.try_wait(), Ok(Some(_))) {
        thread::sleep(Duration::from_millis(10));
    }
    // The leader may be gone while a grandchild lingers, so kill the group regardless.
    unsafe { libc::killpg(pgid, libc::SIGKILL) };
    let _ = child.wait();
}

/// Script for `sh -c` (destination is `$1`): unpack the tar stream into a staging dir, require
/// the `done` marker, then move each item into place without ever replacing anything.
pub fn upload_cmd(names: &[String]) -> String {
    let mut s = String::from(
        "set -e\n\
         t=$(mktemp -d \"$1/.herdr-upload.XXXXXX\"); trap 'rm -rf \"$t\"' EXIT\n\
         trap 'exit 1' HUP INT TERM\n\
         tar --no-same-owner -xf - -C \"$t\"\n\
         if [ ! -e \"$t\"/done ]; then echo 'upload was interrupted' >&2; exit 1; fi\n",
    );
    for name in names {
        let n = sh_quote(name);
        let msg = sh_quote(&format!("{name} already exists, try again"));
        s.push_str(&format!(
            "if [ -e \"$1\"/{n} ] || [ -L \"$1\"/{n} ]; then printf '%s\\n' {msg} >&2; exit 1; fi\n\
             mv -n -- \"$t\"/i/{n} \"$1\"/{n} || true\n\
             if [ -e \"$t\"/i/{n} ] || [ -L \"$t\"/i/{n} ]; then printf '%s\\n' {msg} >&2; exit 1; fi\n"
        ));
    }
    s
}

/// Write a tar stream: each source as `i/<name>` (symlinks kept as links), then an empty `done`
/// entry. Without `done` the remote places nothing. Errors keep their kind, so a broken pipe
/// (the Machine stopped reading) can be told from a local read failure.
pub fn write_upload_stream(w: impl Write, items: &[(Source, String)]) -> io::Result<()> {
    let ctx = |what: String| move |e: io::Error| io::Error::new(e.kind(), format!("{what}: {e}"));
    let mut b = tar::Builder::new(w);
    b.follow_symlinks(false);
    for (s, name) in items {
        let in_tar = format!("i/{name}");
        let added = if s.is_dir {
            b.append_dir_all(&in_tar, &s.path)
        } else {
            b.append_path_with_name(&s.path, &in_tar)
        };
        added.map_err(ctx(s.path.display().to_string()))?;
    }
    let mut h = tar::Header::new_gnu();
    h.set_size(0);
    h.set_mode(0o644);
    h.set_entry_type(tar::EntryType::Regular);
    b.append_data(&mut h, "done", &b""[..])
        .map_err(ctx("cannot append done marker".into()))?;
    b.into_inner()
        .map(drop)
        .map_err(ctx("upload stream".into()))
}

/// Copy `sources` into the folder `dest_abs` on the Machine, never replacing anything. `existing`
/// are the names already there. Blocking; returns the final names in source order.
pub fn upload(
    t: &dyn Transport,
    dest_abs: &str,
    existing: &[String],
    sources: Vec<Source>,
) -> AppResult<Vec<String>> {
    let mut taken = taken_set(existing.iter().map(String::as_str));
    let items: Vec<(Source, String)> = sources
        .into_iter()
        .map(|s| {
            let name = unique_name(&mut taken, &s.name, s.is_dir);
            (s, name)
        })
        .collect();
    let names: Vec<String> = items.iter().map(|(_, n)| n.clone()).collect();
    let argv = script_argv(&upload_cmd(&names), &[dest_abs]);
    let (exit, io) = run_piped(t, &argv, TRANSFER_TIMEOUT, move |stdin, _| {
        Ok(write_upload_stream(stdin, &items))
    })?;
    upload_outcome(exit, io, names)
}

/// The result of an Upload from the Machine's exit and the local stream's result.
fn upload_outcome(
    exit: Exit,
    io: AppResult<io::Result<()>>,
    names: Vec<String>,
) -> AppResult<Vec<String>> {
    let local = match io {
        Ok(Ok(())) => None,
        Ok(Err(e)) => Some((
            AppError::new("io", e.to_string()),
            e.kind() == io::ErrorKind::BrokenPipe,
        )),
        Err(e) => Some((e, false)),
    };
    match local {
        // A local failure cut the stream, so whatever the Machine reports (its "interrupted",
        // or its tar's complaint about the cut) is only a symptom. A broken pipe is the
        // opposite: the Machine stopped reading, and its stderr says why.
        Some((e, broken_pipe))
            if exit.code == 0 || !broken_pipe || exit.stderr.contains("upload was interrupted") =>
        {
            Err(e)
        }
        _ if exit.code != 0 => Err(io_error(exit.code, &exit.stderr)),
        Some((e, _)) => Err(e),
        None => Ok(names),
    }
}

/// `(parent_abs, name)` of the item `rel` under the absolute `root`. The root itself is refused.
pub fn download_target(root: &str, rel: &str) -> AppResult<(String, String)> {
    check_rel(rel)?;
    let rel = rel.trim_end_matches('/');
    if rel.is_empty() || rel == "." {
        return Err(AppError::new(
            "invalid",
            "cannot download the whole Workspace folder",
        ));
    }
    let (dir, name) = rel.rsplit_once('/').unwrap_or(("", rel));
    if name == "." {
        return Err(AppError::new("invalid", format!("invalid path: {rel:?}")));
    }
    Ok((join_abs(root, dir), name.to_string()))
}

/// Script for `sh -c` (`$1` the parent folder, `$2` the item): write `./$2` as a tar stream.
/// `./` keeps a name like `@x` from reading as a bsdtar option. A link to a file is saved as
/// the file (`-h` reaches only that one entry); a link to a folder is refused; a dangling
/// link is saved as the link itself.
const DOWNLOAD_SCRIPT: &str = r#"cd "$1" || exit 1
h=
if [ -L "./$2" ]; then
  if [ -d "./$2" ]; then
    printf '%s is a link to a folder: download the folder it points to\n' "$2" >&2
    exit 1
  fi
  if [ -e "./$2" ]; then h=-h; fi
fi
COPYFILE_DISABLE=1 tar -c $h -f - -- "./$2""#;

/// `$HOME/Downloads`, created if missing.
pub fn downloads_dir() -> AppResult<PathBuf> {
    let home = std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .ok_or_else(|| AppError::new("io", "HOME is not set"))?;
    let dir = PathBuf::from(home).join("Downloads");
    fs::create_dir_all(&dir).map_err(|e| AppError::new("io", format!("{}: {e}", dir.display())))?;
    Ok(dir)
}

/// Rename that fails with `AlreadyExists` instead of replacing `to`. On macOS this is atomic and also
/// catches names that differ only by case on case-insensitive volumes.
#[cfg(target_os = "macos")]
fn rename_excl(from: &Path, to: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let from = CString::new(from.as_os_str().as_bytes())?;
    let to = CString::new(to.as_os_str().as_bytes())?;
    // SAFETY: both pointers are valid NUL-terminated strings for the duration of the call.
    if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn rename_excl(from: &Path, to: &Path) -> io::Result<()> {
    if fs::symlink_metadata(to).is_ok() {
        return Err(io::Error::from(io::ErrorKind::AlreadyExists));
    }
    fs::rename(from, to)
}

/// Move `staged` into `dir` as `name`, or as its first free Finder-style variant. Never replaces anything.
fn place(staged: &Path, dir: &Path, name: &str, is_dir: bool) -> AppResult<String> {
    for n in 0..10_000 {
        let c = candidate(name, is_dir, n);
        let to = dir.join(&c);
        match rename_excl(staged, &to) {
            Ok(()) => return Ok(c),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(AppError::new("io", format!("{}: {e}", to.display()))),
        }
    }
    Err(AppError::new(
        "io",
        format!("no free name for {name} in {}", dir.display()),
    ))
}

/// Best-effort: add owner-write to every directory under `root` (symlinks are not followed), so a
/// tree unpacked with read-only folders can be removed.
fn make_tree_writable(root: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = fs::symlink_metadata(root) else {
        return;
    };
    if !meta.is_dir() {
        return;
    }
    let mode = meta.permissions().mode();
    if mode & 0o700 != 0o700 {
        let _ = fs::set_permissions(root, fs::Permissions::from_mode(mode | 0o700));
    }
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            make_tree_writable(&entry.path());
        }
    }
}

/// Move the downloaded `staging/name` into `downloads` under a free name; returns the saved path.
/// A read-only folder cannot be renamed into another parent, so it is made owner-writable for the
/// move and gets its mode back afterwards.
pub fn finish_download(staging: &Path, name: &str, downloads: &Path) -> AppResult<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let staged = staging.join(name);
    let meta = fs::symlink_metadata(&staged)
        .map_err(|_| AppError::new("io", format!("{name}: nothing was downloaded")))?;
    let orig_mode = meta.permissions().mode();
    let widen = meta.is_dir() && orig_mode & 0o700 != 0o700;
    if widen {
        fs::set_permissions(&staged, fs::Permissions::from_mode(orig_mode | 0o700))
            .map_err(|e| AppError::new("io", format!("{}: {e}", staged.display())))?;
    }
    let saved = downloads.join(place(&staged, downloads, name, meta.is_dir())?);
    if widen {
        let _ = fs::set_permissions(&saved, fs::Permissions::from_mode(orig_mode));
    }
    Ok(saved)
}

/// Copy `name` from the folder `parent_abs` on the Machine into `downloads` under a free name.
/// Blocking; returns the saved path. The staging dir is removed on every exit path.
pub fn download(
    t: &dyn Transport,
    parent_abs: &str,
    name: &str,
    downloads: &Path,
) -> AppResult<PathBuf> {
    let staging = tempfile::Builder::new()
        .prefix(".herdr-download.")
        .tempdir_in(downloads)
        .map_err(|e| AppError::new("io", format!("{}: {e}", downloads.display())))?;
    let argv = script_argv(DOWNLOAD_SCRIPT, &[parent_abs, name]);
    let dest = staging.path().to_path_buf();
    let (exit, io) = run_piped(t, &argv, TRANSFER_TIMEOUT, move |stdin, stdout| {
        drop(stdin);
        let stream_err = |e: io::Error| AppError::new("io", format!("download stream: {e}"));
        let mut archive = tar::Archive::new(stdout);
        archive.unpack(&dest).map_err(stream_err)?;
        // The archive ends at its first zero block; the rest of the last record must still be
        // read, or the Machine's `tar` fails writing it to a closed pipe.
        io::copy(&mut archive.into_inner(), &mut io::sink())
            .map(drop)
            .map_err(stream_err)
    })?;
    let saved = if exit.code != 0 {
        Err(io_error(exit.code, &exit.stderr))
    } else {
        io.and_then(|()| finish_download(staging.path(), name, downloads))
    };
    if saved.is_err() {
        // Read-only folders would stop the TempDir drop from removing the staging tree.
        make_tree_writable(staging.path());
    }
    saved
}

/// Canonical form of `p`, or `p` itself when it cannot be resolved.
fn canon(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// On the local Machine, uploading a folder into itself or below itself would never end.
pub fn check_upload_into_self(dest_abs: &Path, sources: &[Source]) -> AppResult<()> {
    let dest = canon(dest_abs);
    for s in sources.iter().filter(|s| s.is_dir) {
        if dest.starts_with(canon(&s.path)) {
            return Err(AppError::new(
                "invalid",
                format!("cannot upload {} into itself", s.name),
            ));
        }
    }
    Ok(())
}

/// On the local Machine, a folder holding `~/Downloads` would be copied into its own copy.
pub fn check_download_contains_downloads(src_abs: &Path, downloads: &Path) -> AppResult<()> {
    let is_dir = fs::symlink_metadata(src_abs)
        .map(|m| m.is_dir())
        .unwrap_or(false);
    if is_dir && canon(downloads).starts_with(canon(src_abs)) {
        return Err(AppError::new(
            "invalid",
            "cannot download a folder that contains Downloads",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    #[test]
    fn candidate_follows_finder_style() {
        assert_eq!(candidate("report.md", false, 0), "report.md");
        assert_eq!(candidate("report.md", false, 1), "report (1).md");
        assert_eq!(candidate("report.md", false, 2), "report (2).md");
        assert_eq!(candidate("assets", true, 1), "assets (1)");
        assert_eq!(candidate("v1.2", true, 1), "v1.2 (1)");
        assert_eq!(candidate(".env", false, 1), ".env (1)");
        assert_eq!(candidate("a.tar.gz", false, 1), "a.tar (1).gz");
        assert_eq!(candidate("x (1).md", false, 1), "x (1) (1).md");
        assert_eq!(candidate("Makefile", false, 1), "Makefile (1)");
    }

    #[test]
    fn unique_name_skips_taken_case_insensitively_and_records_its_pick() {
        let mut taken = taken_set(["Report.md", "report (1).md"]);
        assert_eq!(unique_name(&mut taken, "report.md", false), "report (2).md");
        assert_eq!(unique_name(&mut taken, "new.md", false), "new.md");
        assert_eq!(unique_name(&mut taken, "a.png", false), "a.png");
        assert_eq!(unique_name(&mut taken, "A.png", false), "A (1).png");
    }

    #[test]
    fn join_abs_handles_root_and_slash() {
        assert_eq!(join_abs("/r", ""), "/r");
        assert_eq!(join_abs("/r", "a/b"), "/r/a/b");
        assert_eq!(join_abs("/", "a"), "/a");
        assert_eq!(join_abs("/", ""), "/");
    }

    #[test]
    fn check_sources_validates_paths_and_kinds() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        fs::write(p.join("a.md"), "x").unwrap();
        fs::create_dir(p.join("d")).unwrap();
        symlink(p.join("d"), p.join("link")).unwrap();
        symlink(p.join("missing"), p.join("dangling")).unwrap();

        assert_eq!(check_sources(&[]).unwrap_err().code, "invalid");
        assert_eq!(
            check_sources(&["rel/a.md".into()]).unwrap_err().code,
            "invalid"
        );
        assert_eq!(
            check_sources(&[format!("{}/a\nb", p.display())])
                .unwrap_err()
                .code,
            "invalid"
        );
        assert_eq!(
            check_sources(&[format!("{}/nope", p.display())])
                .unwrap_err()
                .code,
            "not_found"
        );
        let fifo = p.join("pipe");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        assert_eq!(
            check_sources(&[fifo.to_str().unwrap().into()])
                .unwrap_err()
                .code,
            "invalid"
        );

        let got = check_sources(&[
            format!("{}/a.md", p.display()),
            format!("{}/d", p.display()),
            format!("{}/link", p.display()),
            format!("{}/dangling", p.display()),
        ])
        .unwrap();
        let summary: Vec<_> = got.iter().map(|s| (s.name.as_str(), s.is_dir)).collect();
        // A symlink to a folder is not a folder: it is copied as a link.
        assert_eq!(
            summary,
            [
                ("a.md", false),
                ("d", true),
                ("link", false),
                ("dangling", false)
            ]
        );
    }

    use crate::transport::local::LocalTransport;

    fn src(p: &std::path::Path) -> Source {
        check_sources(&[p.to_str().unwrap().to_string()])
            .unwrap()
            .remove(0)
    }
    /// Sorted names in `dir`, hidden ones included.
    fn ls(dir: &std::path::Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn upload_copies_tree_keeps_symlinks_and_renames_on_conflict() {
        let from = tempfile::tempdir().unwrap();
        let f = from.path();
        fs::create_dir_all(f.join("assets/deep")).unwrap();
        fs::write(f.join("assets/deep/b c.md"), "deep").unwrap();
        symlink("deep/b c.md", f.join("assets/link.md")).unwrap();
        fs::write(f.join("it's a b.md"), "q").unwrap();
        let to = tempfile::tempdir().unwrap();
        let t = to.path();
        let dest = t.to_str().unwrap();
        let sources = vec![src(&f.join("assets")), src(&f.join("it's a b.md"))];

        assert_eq!(
            upload(&LocalTransport, dest, &[], sources.clone()).unwrap(),
            ["assets", "it's a b.md"]
        );
        assert_eq!(
            fs::read_to_string(t.join("assets/deep/b c.md")).unwrap(),
            "deep"
        );
        assert_eq!(
            fs::read_link(t.join("assets/link.md")).unwrap(),
            std::path::PathBuf::from("deep/b c.md")
        );
        assert_eq!(fs::read_to_string(t.join("it's a b.md")).unwrap(), "q");

        let existing = ls(t);
        assert_eq!(
            upload(&LocalTransport, dest, &existing, sources).unwrap(),
            ["assets (1)", "it's a b (1).md"]
        );
        assert_eq!(
            ls(t),
            ["assets", "assets (1)", "it's a b (1).md", "it's a b.md"]
        );
    }

    #[test]
    fn upload_fails_on_a_name_taken_after_listing_and_never_replaces() {
        let from = tempfile::tempdir().unwrap();
        fs::write(from.path().join("a.md"), "new").unwrap();
        fs::write(from.path().join("b.md"), "new").unwrap();
        let to = tempfile::tempdir().unwrap();
        fs::write(to.path().join("b.md"), "old").unwrap();
        // The listing missed b.md: it "appeared" after listing.
        let err = upload(
            &LocalTransport,
            to.path().to_str().unwrap(),
            &[],
            vec![
                src(&from.path().join("a.md")),
                src(&from.path().join("b.md")),
            ],
        )
        .unwrap_err();
        assert!(
            err.message.contains("b.md already exists, try again"),
            "{err:?}"
        );
        assert_eq!(fs::read_to_string(to.path().join("b.md")).unwrap(), "old");
        // a.md was moved before the failure and stays; no staging dir is left.
        assert_eq!(ls(to.path()), ["a.md", "b.md"]);
    }

    #[tokio::test]
    async fn upload_skips_names_the_tree_hides() {
        let from = tempfile::tempdir().unwrap();
        fs::create_dir(from.path().join("dist")).unwrap();
        fs::write(from.path().join("dist/new.js"), "new").unwrap();
        fs::write(from.path().join(".env"), "new").unwrap();
        let to = tempfile::tempdir().unwrap();
        fs::create_dir(to.path().join("dist")).unwrap();
        fs::write(to.path().join("dist/old.js"), "old").unwrap();
        fs::write(to.path().join(".env"), "old").unwrap();
        let dest = to.path().to_str().unwrap();
        let existing = crate::files::list::list_names(&LocalTransport, dest, "")
            .await
            .unwrap();
        let sources = vec![
            src(&from.path().join("dist")),
            src(&from.path().join(".env")),
        ];
        assert_eq!(
            upload(&LocalTransport, dest, &existing, sources).unwrap(),
            ["dist (1)", ".env (1)"]
        );
        assert_eq!(ls(&to.path().join("dist")), ["old.js"]);
        assert_eq!(ls(&to.path().join("dist (1)")), ["new.js"]);
    }

    #[test]
    fn upload_cmd_never_restores_the_macs_owner() {
        assert!(upload_cmd(&[]).contains("tar --no-same-owner -xf - -C \"$t\"\n"));
    }

    fn exit(code: i32, stderr: &str) -> Exit {
        Exit {
            code,
            stderr: stderr.into(),
        }
    }
    fn local(kind: io::ErrorKind) -> io::Error {
        io::Error::new(kind, "/src/a.md: local failure")
    }

    #[test]
    fn upload_outcome_prefers_the_local_error_unless_the_pipe_broke() {
        let names = || vec!["a.md".to_string()];
        let msg = |r: AppResult<Vec<String>>| r.unwrap_err().message;
        // A local read error wins over whatever the Machine's tar says about the cut stream.
        assert_eq!(
            msg(upload_outcome(
                exit(1, "tar: Unexpected EOF in archive"),
                Ok(Err(local(io::ErrorKind::PermissionDenied))),
                names()
            )),
            "/src/a.md: local failure"
        );
        assert_eq!(
            msg(upload_outcome(
                exit(1, "upload was interrupted"),
                Ok(Err(local(io::ErrorKind::BrokenPipe))),
                names()
            )),
            "/src/a.md: local failure"
        );
        // A broken pipe only echoes the Machine's failure.
        assert_eq!(
            msg(upload_outcome(
                exit(1, "mktemp: cannot create"),
                Ok(Err(local(io::ErrorKind::BrokenPipe))),
                names()
            )),
            "mktemp: cannot create"
        );
        assert_eq!(
            msg(upload_outcome(
                exit(1, "a.md already exists, try again"),
                Ok(Ok(())),
                names()
            )),
            "a.md already exists, try again"
        );
        assert_eq!(
            msg(upload_outcome(
                exit(0, ""),
                Ok(Err(local(io::ErrorKind::BrokenPipe))),
                names()
            )),
            "/src/a.md: local failure"
        );
        assert_eq!(
            msg(upload_outcome(
                exit(1, "tar: boom"),
                Err(AppError::new("io", "transfer thread panicked")),
                names()
            )),
            "transfer thread panicked"
        );
        assert_eq!(
            upload_outcome(exit(0, ""), Ok(Ok(())), names()).unwrap(),
            names()
        );
    }

    #[test]
    fn upload_without_the_done_marker_places_nothing() {
        let to = tempfile::tempdir().unwrap();
        let argv: Vec<String> = [
            "sh",
            "-c",
            &upload_cmd(&["a.md".into()]),
            "sh",
            to.path().to_str().unwrap(),
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let (exit, io) = run_piped(&LocalTransport, &argv, TRANSFER_TIMEOUT, |stdin, _| {
            let mut b = tar::Builder::new(stdin);
            let mut h = tar::Header::new_gnu();
            h.set_size(1);
            h.set_mode(0o644);
            b.append_data(&mut h, "i/a.md", &b"x"[..]).unwrap();
            b.into_inner()
                .map(drop)
                .map_err(|e| AppError::new("io", e.to_string()))
        })
        .unwrap();
        io.unwrap();
        assert_ne!(exit.code, 0);
        assert!(
            exit.stderr.contains("upload was interrupted"),
            "{}",
            exit.stderr
        );
        assert!(ls(to.path()).is_empty());
    }

    #[test]
    fn upload_reports_the_local_error_when_a_source_cannot_be_read() {
        let from = tempfile::tempdir().unwrap();
        let locked = from.path().join("locked.md");
        fs::write(&locked, "x").unwrap();
        let s = src(&locked);
        fs::set_permissions(&locked, std::os::unix::fs::PermissionsExt::from_mode(0o000)).unwrap();
        let to = tempfile::tempdir().unwrap();
        let err = upload(&LocalTransport, to.path().to_str().unwrap(), &[], vec![s]).unwrap_err();
        assert!(err.message.contains("locked.md"), "{err:?}");
        assert!(ls(to.path()).is_empty());
    }

    #[test]
    fn run_piped_kills_the_child_after_the_timeout() {
        let argv: Vec<String> = vec!["sleep".into(), "5".into()];
        let started = std::time::Instant::now();
        let err = run_piped(
            &LocalTransport,
            &argv,
            Duration::from_millis(200),
            |stdin, _| {
                drop(stdin);
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(err.code, "timeout");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn run_piped_timeout_stops_grandchildren_and_removes_staging() {
        let to = tempfile::tempdir().unwrap();
        let argv = script_argv(
            &upload_cmd(&["a.md".into()]),
            &[to.path().to_str().unwrap()],
        );
        let started = std::time::Instant::now();
        let err = run_piped(
            &LocalTransport,
            &argv,
            Duration::from_millis(300),
            move |stdin, mut stdout| {
                let _keep = stdin;
                let mut v = Vec::new();
                stdout
                    .read_to_end(&mut v)
                    .map(drop)
                    .map_err(|e| AppError::new("io", e.to_string()))
            },
        )
        .unwrap_err();
        assert_eq!(err.code, "timeout");
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(ls(to.path()).is_empty(), "{:?}", ls(to.path()));
    }

    #[test]
    fn download_target_splits_and_refuses_the_root() {
        assert_eq!(
            download_target("/r", "a/b.md").unwrap(),
            ("/r/a".to_string(), "b.md".to_string())
        );
        assert_eq!(
            download_target("/r", "b.md").unwrap(),
            ("/r".to_string(), "b.md".to_string())
        );
        assert_eq!(
            download_target("/", "b").unwrap(),
            ("/".to_string(), "b".to_string())
        );
        assert_eq!(download_target("/r", "").unwrap_err().code, "invalid");
        assert_eq!(download_target("/r", "../x").unwrap_err().code, "invalid");
        for rel in [".", "./"] {
            let e = download_target("/r", rel).unwrap_err();
            assert_eq!(
                (e.code.as_str(), e.message.as_str()),
                ("invalid", "cannot download the whole Workspace folder"),
                "{rel:?}"
            );
        }
        for rel in ["a/.", "a/./", "a/b/."] {
            assert_eq!(
                download_target("/r", rel).unwrap_err().code,
                "invalid",
                "{rel:?}"
            );
        }
    }

    /// Runs the real command, then writes a trailer after a pause, like a remote `tar -c` whose
    /// last record write comes after the archive's end-of-archive blocks were read.
    struct LateTrailer;

    #[async_trait::async_trait]
    impl Transport for LateTrailer {
        fn wrap(&self, argv: &[String], _tty: bool) -> Vec<String> {
            let mut v: Vec<String> = [
                "sh",
                "-c",
                "\"$@\" || exit; sleep 0.3; head -c 65536 /dev/zero",
                "sh",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect();
            v.extend(argv.iter().cloned());
            v
        }
        async fn local_socket(
            &self,
            _s: &crate::transport::SessionEntry,
        ) -> AppResult<std::path::PathBuf> {
            unreachable!()
        }
        async fn release_socket(&self, _s: &crate::transport::SessionEntry) -> AppResult<()> {
            unreachable!()
        }
    }

    #[test]
    fn download_reads_the_stream_to_its_end() {
        let ws = tempfile::tempdir().unwrap();
        fs::write(ws.path().join("a.md"), "a").unwrap();
        let dl = tempfile::tempdir().unwrap();
        let saved = download(&LateTrailer, ws.path().to_str().unwrap(), "a.md", dl.path()).unwrap();
        assert_eq!(fs::read_to_string(saved).unwrap(), "a");
    }

    #[test]
    fn download_handles_a_name_starting_with_at() {
        let ws = tempfile::tempdir().unwrap();
        fs::write(ws.path().join("@at"), "at").unwrap();
        let dl = tempfile::tempdir().unwrap();
        let saved = download(
            &LocalTransport,
            ws.path().to_str().unwrap(),
            "@at",
            dl.path(),
        )
        .unwrap();
        assert_eq!(saved, dl.path().join("@at"));
        assert_eq!(fs::read_to_string(&saved).unwrap(), "at");
        assert_eq!(ls(dl.path()), ["@at"]);
    }

    #[test]
    fn download_of_a_link_to_a_file_saves_the_file() {
        let ws = tempfile::tempdir().unwrap();
        fs::write(ws.path().join("target.md"), "t").unwrap();
        symlink("target.md", ws.path().join("flink")).unwrap();
        let dl = tempfile::tempdir().unwrap();
        let saved = download(
            &LocalTransport,
            ws.path().to_str().unwrap(),
            "flink",
            dl.path(),
        )
        .unwrap();
        assert_eq!(saved, dl.path().join("flink"));
        assert!(fs::symlink_metadata(&saved).unwrap().file_type().is_file());
        assert_eq!(fs::read_to_string(&saved).unwrap(), "t");
        assert_eq!(ls(dl.path()), ["flink"]);
    }

    #[test]
    fn download_of_a_link_to_a_folder_is_refused() {
        let ws = tempfile::tempdir().unwrap();
        fs::create_dir(ws.path().join("d")).unwrap();
        fs::write(ws.path().join("d/x.md"), "x").unwrap();
        symlink("d", ws.path().join("dlink")).unwrap();
        let dl = tempfile::tempdir().unwrap();
        let err = download(
            &LocalTransport,
            ws.path().to_str().unwrap(),
            "dlink",
            dl.path(),
        )
        .unwrap_err();
        assert_eq!(err.code, "io");
        assert_eq!(
            err.message,
            "dlink is a link to a folder: download the folder it points to"
        );
        assert!(ls(dl.path()).is_empty());
    }

    #[test]
    fn download_of_a_dangling_link_saves_the_link() {
        let ws = tempfile::tempdir().unwrap();
        symlink("missing", ws.path().join("dangling")).unwrap();
        let dl = tempfile::tempdir().unwrap();
        let saved = download(
            &LocalTransport,
            ws.path().to_str().unwrap(),
            "dangling",
            dl.path(),
        )
        .unwrap();
        assert_eq!(
            fs::read_link(&saved).unwrap(),
            std::path::PathBuf::from("missing")
        );
        assert_eq!(ls(dl.path()), ["dangling"]);
    }

    #[test]
    fn download_saves_files_and_folders_under_free_names() {
        let ws = tempfile::tempdir().unwrap();
        fs::create_dir_all(ws.path().join("dir/sub")).unwrap();
        fs::write(ws.path().join("dir/sub/x.md"), "x").unwrap();
        fs::write(ws.path().join("a.md"), "new").unwrap();
        let dl = tempfile::tempdir().unwrap();
        fs::write(dl.path().join("A.md"), "old").unwrap();
        let parent = ws.path().to_str().unwrap();
        // On a case-sensitive volume `a.md` is free, so the clash cannot be exercised there.
        if dl.path().join("a.md").exists() {
            let saved = download(&LocalTransport, parent, "a.md", dl.path()).unwrap();
            assert_eq!(saved, dl.path().join("a (1).md"));
            assert_eq!(fs::read_to_string(&saved).unwrap(), "new");
            assert_eq!(fs::read_to_string(dl.path().join("A.md")).unwrap(), "old");
        } else {
            fs::remove_file(dl.path().join("A.md")).unwrap();
            fs::write(dl.path().join("A.md"), "old").unwrap();
            fs::write(dl.path().join("a (1).md"), "placeholder").unwrap();
        }

        let saved = download(&LocalTransport, parent, "dir", dl.path()).unwrap();
        assert_eq!(saved, dl.path().join("dir"));
        assert_eq!(fs::read_to_string(saved.join("sub/x.md")).unwrap(), "x");
        // No staging dir and no AppleDouble files are left behind.
        assert_eq!(ls(dl.path()), ["A.md", "a (1).md", "dir"]);
        assert_eq!(ls(&saved), ["sub"]);
    }

    #[test]
    fn download_of_a_missing_item_fails_and_leaves_nothing() {
        let ws = tempfile::tempdir().unwrap();
        let dl = tempfile::tempdir().unwrap();
        let err = download(
            &LocalTransport,
            ws.path().to_str().unwrap(),
            "nope.md",
            dl.path(),
        )
        .unwrap_err();
        assert_eq!(err.code, "io");
        assert!(ls(dl.path()).is_empty());
    }

    #[test]
    fn download_of_a_read_only_folder_saves_it_and_keeps_its_mode() {
        use std::os::unix::fs::PermissionsExt;
        let ws = tempfile::tempdir().unwrap();
        let ro = ws.path().join("ro");
        fs::create_dir(&ro).unwrap();
        fs::write(ro.join("x.md"), "x").unwrap();
        fs::set_permissions(&ro, fs::Permissions::from_mode(0o555)).unwrap();
        let dl = tempfile::tempdir().unwrap();
        let res = download(
            &LocalTransport,
            ws.path().to_str().unwrap(),
            "ro",
            dl.path(),
        );
        let saved_dir = dl.path().join("ro");
        let mode = fs::metadata(&saved_dir).map(|m| m.permissions().mode() & 0o777);
        let listing = ls(dl.path());
        // Restore permissions so the tempdirs can be removed.
        make_tree_writable(&ro);
        make_tree_writable(&saved_dir);
        assert_eq!(res.unwrap(), saved_dir);
        assert_eq!(mode.unwrap(), 0o555);
        assert_eq!(listing, ["ro"]);
        assert_eq!(fs::read_to_string(saved_dir.join("x.md")).unwrap(), "x");
    }

    #[test]
    fn make_tree_writable_lets_a_read_only_tree_be_removed() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let top = d.path().join("top");
        fs::create_dir_all(top.join("sub")).unwrap();
        fs::write(top.join("sub/x"), "x").unwrap();
        symlink(d.path(), top.join("loop")).unwrap();
        for p in [top.join("sub"), top.clone()] {
            fs::set_permissions(&p, fs::Permissions::from_mode(0o555)).unwrap();
        }
        make_tree_writable(&top);
        fs::remove_dir_all(&top).unwrap();
        assert!(!top.exists());
    }

    #[test]
    fn refuses_to_upload_a_folder_into_itself() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join("x/inner")).unwrap();
        let s = vec![src(&d.path().join("x"))];
        assert_eq!(
            check_upload_into_self(&d.path().join("x/inner"), &s)
                .unwrap_err()
                .code,
            "invalid"
        );
        assert_eq!(
            check_upload_into_self(&d.path().join("x"), &s)
                .unwrap_err()
                .code,
            "invalid"
        );
        assert!(check_upload_into_self(d.path(), &s).is_ok());
    }

    #[test]
    fn refuses_to_download_a_folder_that_contains_downloads() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join("Downloads")).unwrap();
        fs::create_dir_all(home.path().join("w")).unwrap();
        let dl = home.path().join("Downloads");
        assert_eq!(
            check_download_contains_downloads(home.path(), &dl)
                .unwrap_err()
                .code,
            "invalid"
        );
        assert!(check_download_contains_downloads(&home.path().join("w"), &dl).is_ok());
    }
}
