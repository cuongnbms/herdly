//! Pure pieces of the live Files watch: the remote commands, their output parsers, and the
//! event types sent to the UI. No I/O here.

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;

use crate::complete::files::SKIP_DIRS;
use crate::transport::sh_quote;

const BACKOFF_SECS: [u64; 4] = [1, 2, 5, 10];

/// Seconds between scans of the portable poll fallback.
pub const POLL_SECS: u64 = 2;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub is_dir: bool,
    pub removed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WatchEvent {
    Resync,
    Changes { changes: Vec<Change> },
    Error { message: String },
}

/// The remote session has no tty, so sshd never signals it when the channel closes, and
/// `inotifywait` only notices on its next write: in a quiet tree it would live on, holding
/// its watches. So a background `cat` waits for the session's stdin (kept open by the app)
/// to reach EOF, then kills the watcher, which `exec` gave the shell's pid (`$$`). The
/// watchdog's own output goes to /dev/null so a failed `inotifywait` still closes stdout.
///
/// `--exclude` only filters events: `-r` still puts a watch on every folder below, and a
/// big `node_modules` alone can use up the host's inotify watch limit. Folders listed with
/// `@` in `--fromfile` are not watched at all, so `find` lists the heavy ones present now
/// and feeds them in through a here-doc. The event filter drops only what happens *inside* a
/// heavy folder, so creating a new one still arrives (see `adds_excluded_dir`). The filter is
/// anchored at the root: a root that itself sits under, say, `.worktrees` keeps its events.
///
/// Without `-q`, `inotifywait` says `Watches established.` on stderr once it is watching.
pub fn inotify_cmd(abs: &str) -> String {
    let q = sh_quote(abs);
    let names = SKIP_DIRS
        .iter()
        .map(|n| ere_escape(n))
        .collect::<Vec<_>>()
        .join("|");
    let filter = format!(
        "^{}/(.*/)?({names})/",
        ere_escape(abs.trim_end_matches('/'))
    );
    let find_names = SKIP_DIRS
        .iter()
        .map(|n| format!("-name {}", sh_quote(n)))
        .collect::<Vec<_>>()
        .join(" -o ");
    // The root stays on the command line (not in the list) so `ps` shows what is watched.
    format!(
        "exec 3<&0; (cat; kill $$) <&3 >/dev/null 2>&1 & exec inotifywait -m -r -e close_write,create,delete,moved_to,moved_from,delete_self,move_self --format '%e|%w%f' --exclude {} --fromfile - {q} 3<&- <<HERDR_WATCH\n$(find -H {q} -mindepth 1 \\( {find_names} \\) -prune -printf '@%p\\n' 2>/dev/null)\nHERDR_WATCH\n",
        sh_quote(&filter)
    )
}

/// Portable fallback for hosts without `inotifywait`: every `POLL_SECS` list what changed
/// since the previous scan, as NUL-separated `d|f<TAB>path` records, ending each scan with an
/// `e` record. A marker file's mtime stands in for the clock (no `-newermt`, which BSD `find`
/// and busybox lack); the new marker is touched *before* the scan so nothing is missed.
/// Heavy folders are pruned, but never the root itself (a root may be named `build`). Once the
/// root is gone an `x` record ends the loop. Same stdin watchdog as `inotify_cmd`.
pub fn poll_cmd(abs: &str) -> String {
    let q = sh_quote(abs);
    let names = SKIP_DIRS
        .iter()
        .map(|n| format!("-name {}", sh_quote(n)))
        .collect::<Vec<_>>()
        .join(" -o ");
    // `-path` takes a glob, so the root's own glob characters are escaped.
    let prune = format!(
        "\\( ! -path {} -type d \\( {names} \\) \\) -prune",
        sh_quote(&glob_escape(abs))
    );
    format!(
        "exec 3<&0; (cat; kill $$) <&3 >/dev/null 2>&1 &\n\
d=$(mktemp -d) || exit 1\n\
trap 'rm -rf \"$d\"' EXIT\n\
trap 'exit 0' TERM HUP INT\n\
touch \"$d/prev\"\n\
while :; do\n\
  [ -d {q} ] || {{ printf 'x\\t\\0'; exit 1; }}\n\
  sleep {POLL_SECS}; touch \"$d/next\"\n\
  find -H {q} {prune} -o -newer \"$d/prev\" \\( -type d -exec printf 'd\\t%s\\0' {{}} + -o -exec printf 'f\\t%s\\0' {{}} + \\) 3<&- 2>/dev/null\n\
  printf 'e\\t\\0'\n\
  mv \"$d/next\" \"$d/prev\"\n\
done\n"
    )
}

/// Escape a path for a `find -path` glob.
fn glob_escape(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        if "*?[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Escape a name for a POSIX extended regex.
fn ere_escape(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if ".[]()*+?{}|^$\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// True when `change` is a heavy folder appearing (created or moved in). `inotifywait -r`
/// starts watching everything inside it, so the watcher is restarted to leave it out again.
pub fn adds_excluded_dir(change: &Change) -> bool {
    change.is_dir
        && !change.removed
        && SKIP_DIRS.contains(&change.path.rsplit('/').next().unwrap_or(""))
}

/// Why the watch session ended, from its stderr: the first non-empty line (`inotifywait`
/// states the error there, e.g. the inotify watch limit, then adds advice), else a generic message.
/// The local ssh client's own notices (e.g. a busy ControlSocket) share the stream and are
/// skipped, as are `inotifywait`'s progress lines.
pub fn exit_message(stderr: &str) -> String {
    const NOTICES: [&str; 5] = [
        "ControlSocket ",
        "mux_client",
        "Warning: Permanently added",
        "Setting up watches.",
        ESTABLISHED,
    ];
    stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !NOTICES.iter().any(|n| l.starts_with(n)))
        .map_or_else(|| "watch session ended".to_string(), str::to_string)
}

/// The stderr line `inotifywait` prints once every watch is in place.
pub const ESTABLISHED: &str = "Watches established.";

/// Why a watch on `root` is refused: scanning the home folder walks `~/Library` (macOS privacy
/// prompts) and `/` is the whole machine.
pub fn watch_refusal(home: &str, root: &str) -> Option<&'static str> {
    if root.trim_end_matches('/').is_empty() {
        Some("auto-refresh is off for the root folder")
    } else if crate::complete::files::is_home(home, root) {
        Some("auto-refresh is off for the home folder")
    } else {
        None
    }
}

/// The change that says the root itself is gone.
pub fn root_removed() -> Change {
    Change {
        path: String::new(),
        is_dir: true,
        removed: true,
    }
}

/// Path of `full` relative to `root` (trailing `/` ignored); the root itself is `""`.
fn relative(root: &str, full: &str) -> Option<String> {
    let root = root.trim_end_matches('/');
    if full == root {
        return Some(String::new());
    }
    Some(
        full.strip_prefix(root)?
            .strip_prefix('/')?
            .trim_end_matches('/')
            .to_string(),
    )
}

/// One `inotify_cmd` line. `DELETE_SELF`/`MOVE_SELF` count only for the root (a folder below
/// also gets `DELETE,ISDIR` or `MOVED_FROM,ISDIR` from its parent's watch).
pub fn parse_inotify_line(root: &str, line: &str) -> Option<Change> {
    let (events, full) = line.split_once('|')?;
    let path = relative(root, full)?;
    if events.contains("_SELF") {
        return path.is_empty().then(root_removed);
    }
    Some(Change {
        path,
        is_dir: events.contains("ISDIR"),
        removed: events.contains("DELETE") || events.contains("MOVED_FROM"),
    })
}

pub enum PollRecord {
    Change(Change),
    /// End of one scan.
    End,
    /// The root no longer exists; the loop has ended.
    RootGone,
}

/// One NUL-separated record of `poll_cmd` output (without the NUL).
pub fn parse_poll_record(root: &str, rec: &[u8]) -> Option<PollRecord> {
    let s = String::from_utf8_lossy(rec);
    let (kind, path) = s.split_once('\t')?;
    match kind {
        "e" => Some(PollRecord::End),
        "x" => Some(PollRecord::RootGone),
        "d" | "f" => Some(PollRecord::Change(Change {
            path: relative(root, path)?,
            is_dir: kind == "d",
            removed: false,
        })),
        _ => None,
    }
}

pub fn dedupe(changes: Vec<Change>) -> Vec<Change> {
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<Change> = Vec::new();
    for c in changes {
        if let Some(&i) = index.get(&c.path) {
            out[i] = c;
        } else {
            index.insert(c.path.clone(), out.len());
            out.push(c);
        }
    }
    out
}

#[derive(Default)]
pub struct Backoff {
    attempt: usize,
}

impl Backoff {
    pub fn next_delay(&mut self) -> Duration {
        let secs = BACKOFF_SECS[self.attempt.min(BACKOFF_SECS.len() - 1)];
        self.attempt += 1;
        Duration::from_secs(secs)
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(path: &str, is_dir: bool, removed: bool) -> Change {
        Change {
            path: path.into(),
            is_dir,
            removed,
        }
    }

    #[test]
    fn inotify_cmd_watches_recursively_and_skips_heavy_dirs() {
        let cmd = inotify_cmd("/r/p q");
        assert!(cmd.starts_with("exec 3<&0; (cat; kill $$) <&3 >/dev/null 2>&1 & exec inotifywait -m -r -e close_write,create,delete,moved_to,moved_from,delete_self,move_self --format '%e|%w%f'"), "{cmd}");
        // Events inside a heavy folder below the root are dropped, the folder's own creation is not.
        assert!(cmd.contains(r"--exclude '^/r/p q/(.*/)?(\.git|node_modules|\.venv|venv|__pycache__|target|dist|build|\.next|\.worktrees)/'"), "{cmd}");
        // Heavy folders present now get no watches at all.
        assert!(cmd.contains(" --fromfile - '/r/p q' 3<&- <<HERDR_WATCH\n$(find -H '/r/p q' -mindepth 1 \\( -name '.git' -o -name 'node_modules' -o -name '.venv' -o -name 'venv' -o -name '__pycache__' -o -name 'target' -o -name 'dist' -o -name 'build' -o -name '.next' -o -name '.worktrees' \\) -prune -printf '@%p\\n' 2>/dev/null)\nHERDR_WATCH\n"), "{cmd}");
        assert!(inotify_cmd("/it's").contains(r"'/it'\''s'"));
    }

    #[test]
    fn poll_cmd_loops_on_a_marker_file_with_heavy_dirs_pruned() {
        let cmd = poll_cmd("/r/p q");
        assert!(
            cmd.starts_with("exec 3<&0; (cat; kill $$) <&3 >/dev/null 2>&1 &\n"),
            "{cmd}"
        );
        assert!(cmd.contains("trap 'rm -rf \"$d\"' EXIT"), "{cmd}");
        assert!(cmd.contains("sleep 2;"), "{cmd}");
        // The root itself is never pruned, whatever its name.
        assert!(
            cmd.contains("find -H '/r/p q' \\( ! -path '/r/p q' -type d \\( -name '.git' -o -name 'node_modules' -o -name '.venv' -o -name 'venv' -o -name '__pycache__' -o -name 'target' -o -name 'dist' -o -name 'build' -o -name '.next' -o -name '.worktrees' \\) \\) -prune -o -newer \"$d/prev\""),
            "{cmd}"
        );
        assert!(
            cmd.contains("[ -d '/r/p q' ] || { printf 'x\\t\\0'; exit 1; }"),
            "{cmd}"
        );
        assert!(poll_cmd("/r/a*[b]").contains(r"-path '/r/a\*\[b\]'"));
        assert!(
            cmd.contains(r"-type d -exec printf 'd\t%s\0' {} + -o -exec printf 'f\t%s\0' {} +"),
            "{cmd}"
        );
        assert!(cmd.contains(r"printf 'e\t\0'"), "{cmd}");
        assert!(cmd.contains("mv \"$d/next\" \"$d/prev\""), "{cmd}");
    }

    #[test]
    fn parses_poll_records() {
        let p = |rec: &[u8]| parse_poll_record("/r/", rec);
        assert!(
            matches!(p(b"f\t/r/docs/a\tb.md"), Some(PollRecord::Change(ch)) if ch == c("docs/a\tb.md", false, false))
        );
        assert!(
            matches!(p(b"d\t/r/new\ndir"), Some(PollRecord::Change(ch)) if ch == c("new\ndir", true, false))
        );
        assert!(matches!(p(b"d\t/r"), Some(PollRecord::Change(ch)) if ch == c("", true, false)));
        assert!(matches!(p(b"e\t"), Some(PollRecord::End)));
        assert!(matches!(p(b"x\t"), Some(PollRecord::RootGone)));
        assert!(p(b"f\t/other/x").is_none());
        assert!(p(b"garbage").is_none());
    }

    #[test]
    fn parses_inotify_lines() {
        assert_eq!(
            parse_inotify_line("/r", "CLOSE_WRITE,CLOSE|/r/docs/a b.md"),
            Some(c("docs/a b.md", false, false))
        );
        assert_eq!(
            parse_inotify_line("/r/", "CREATE,ISDIR|/r/new"),
            Some(c("new", true, false))
        );
        assert_eq!(
            parse_inotify_line("/r", "DELETE|/r/x.md"),
            Some(c("x.md", false, true))
        );
        assert_eq!(
            parse_inotify_line("/r", "MOVED_FROM|/r/y|z.md"),
            Some(c("y|z.md", false, true))
        );
        // The root going away (inotifywait writes the watched folder with a trailing `/`).
        assert_eq!(
            parse_inotify_line("/r", "DELETE_SELF|/r/"),
            Some(c("", true, true))
        );
        assert_eq!(
            parse_inotify_line("/r", "MOVE_SELF|/r/"),
            Some(c("", true, true))
        );
        // A folder below gets its own record from its parent's watch.
        assert_eq!(parse_inotify_line("/r", "DELETE_SELF|/r/sub/"), None);
        assert_eq!(parse_inotify_line("/r", "MOVE_SELF|/r/sub/"), None);
        assert_eq!(parse_inotify_line("/r", "CREATE|/other/x"), None);
        assert_eq!(parse_inotify_line("/r", "garbage"), None);
    }

    #[test]
    fn adds_excluded_dir_only_for_new_heavy_folders() {
        assert!(adds_excluded_dir(&c("web/node_modules", true, false)));
        assert!(adds_excluded_dir(&c(".venv", true, false)));
        assert!(!adds_excluded_dir(&c("web/node_modules", true, true)));
        assert!(!adds_excluded_dir(&c("web/node_modules", false, false)));
        assert!(!adds_excluded_dir(&c("node_modules/x", true, false)));
        assert!(!adds_excluded_dir(&c("my_venv", true, false)));
    }

    #[test]
    fn exit_message_prefers_the_first_stderr_line() {
        let stderr =
            "\nFailed to watch /r; upper limit on inotify watches reached!\nPlease increase…\n";
        assert_eq!(
            exit_message(stderr),
            "Failed to watch /r; upper limit on inotify watches reached!"
        );
        assert_eq!(exit_message(" \n"), "watch session ended");
        let progress = "Setting up watches.  Beware: since -r was given, this may take a while!\nWatches established.\nFailed to watch /r; upper limit on inotify watches reached!\n";
        assert_eq!(
            exit_message(progress),
            "Failed to watch /r; upper limit on inotify watches reached!"
        );
        assert_eq!(
            exit_message("Setting up watches.\nWatches established.\n"),
            "watch session ended"
        );
        let noisy = "ControlSocket /u/.ssh/cm already exists, disabling multiplexing\r\nCouldn't watch /r: No such file or directory\n";
        assert_eq!(
            exit_message(noisy),
            "Couldn't watch /r: No such file or directory"
        );
    }

    #[test]
    fn inotify_filter_is_anchored_at_the_root() {
        // A root under (or named like) a heavy folder still gets events.
        let cmd = inotify_cmd("/w/.worktrees/x");
        assert!(
            cmd.contains(r"--exclude '^/w/\.worktrees/x/(.*/)?(\.git|"),
            "{cmd}"
        );
        assert!(inotify_cmd("/w/build/").contains(r"--exclude '^/w/build/(.*/)?("));
    }

    #[test]
    fn refuses_the_home_and_root_folders() {
        assert_eq!(
            watch_refusal("/home/u", "/"),
            Some("auto-refresh is off for the root folder")
        );
        assert_eq!(
            watch_refusal("/home/u", "/home/u/"),
            Some("auto-refresh is off for the home folder")
        );
        assert_eq!(watch_refusal("/home/u", "/home/u/p"), None);
    }

    #[test]
    fn dedupe_keeps_first_position_last_value() {
        assert_eq!(
            dedupe(vec![
                c("a", false, false),
                c("b", false, false),
                c("a", false, true)
            ]),
            vec![c("a", false, true), c("b", false, false)]
        );
    }

    #[test]
    fn backoff_sequence_and_reset() {
        let mut b = Backoff::default();
        let secs: Vec<u64> = (0..6).map(|_| b.next_delay().as_secs()).collect();
        assert_eq!(secs, [1, 2, 5, 10, 10, 10]);
        b.reset();
        assert_eq!(b.next_delay().as_secs(), 1);
    }

    #[test]
    fn both_scripts_follow_a_symlinked_root() {
        assert!(poll_cmd("/r").contains("find -H '/r' "));
        assert!(inotify_cmd("/r").contains("$(find -H '/r' -mindepth 1"));
    }

    #[test]
    fn events_serialize_for_the_ui() {
        let v = serde_json::to_value(WatchEvent::Changes {
            changes: vec![c("a", true, false)],
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"type":"changes","changes":[{"path":"a","isDir":true,"removed":false}]})
        );
        assert_eq!(
            serde_json::to_value(WatchEvent::Resync).unwrap(),
            serde_json::json!({"type":"resync"})
        );
        assert_eq!(
            serde_json::to_value(WatchEvent::Error {
                message: "x".into()
            })
            .unwrap(),
            serde_json::json!({"type":"error","message":"x"})
        );
    }
}
