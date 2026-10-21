//! Read-only git for the Git view and the Chat lens status line (ADR 0010).
use crate::error::{AppError, AppResult};
use crate::transport::{exec, exec_bytes, ExecBytes, ExecOutput, Transport};

mod diff;
mod log;
mod repo;
mod status;

pub use diff::{git_diff, DiffLine, DiffScope, FileDiff, Hunk, LineKind};
pub use log::*;
pub use repo::*;

pub use status::{git_status, GitChange, GitStatus, MAX_CHANGES};

/// Every git invocation starts with this; spliced into scripts with `format!`.
pub const GIT: &str = "git --no-optional-locks --no-pager -c core.quotepath=off -c color.ui=never";

/// A failed git run as an error: git's stderr, or its exit status when it said nothing.
pub(crate) fn failed(o: &ExecOutput) -> AppError {
    let msg = o.stderr.trim();
    if msg.is_empty() {
        AppError::new("git", format!("git exited with status {}", o.status))
    } else {
        AppError::new("git", msg)
    }
}

/// A commit id as `git log` prints it: 4 to 64 lowercase hex digits.
pub(crate) fn valid_sha(s: &str) -> bool {
    (4..=64).contains(&s.len()) && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Run `script` in `dir` as `sh -c script sh dir args…` (after `cd "$1"` and `shift`, so the
/// script sees `args` as `"$@"`). A missing folder is `not_found`; any other exit status is
/// returned for the caller to judge.
pub(crate) async fn run(
    t: &dyn Transport,
    dir: &str,
    script: &str,
    args: &[&str],
) -> AppResult<ExecOutput> {
    let o = exec(t, &argv(dir, script, args)).await?;
    if o.status == 97 {
        return Err(not_found(dir));
    }
    Ok(o)
}

fn not_found(dir: &str) -> AppError {
    AppError::new("not_found", format!("no such folder: {dir}"))
}

fn argv(dir: &str, script: &str, args: &[&str]) -> Vec<String> {
    let mut argv = vec![
        "sh".to_string(),
        "-c".into(),
        format!("cd \"$1\" 2>/dev/null || exit 97; shift; {script}"),
        "sh".into(),
        dir.to_string(),
    ];
    argv.extend(args.iter().map(|a| a.to_string()));
    argv
}

/// `run` with stdout kept as raw bytes, for output whose length must be exact.
pub(crate) async fn run_bytes(
    t: &dyn Transport,
    dir: &str,
    script: &str,
    args: &[&str],
) -> AppResult<ExecBytes> {
    let o = exec_bytes(t, &argv(dir, script, args)).await?;
    if o.status == 97 {
        return Err(not_found(dir));
    }
    Ok(o)
}

#[cfg(test)]
pub(crate) mod testutil {
    use std::path::Path;
    use std::process::Command;

    fn command(dir: &Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap()
    }

    pub(crate) fn git(dir: &Path, args: &[&str]) {
        assert!(command(dir, args).status.success(), "git {args:?}");
    }

    pub(crate) fn git_out(dir: &Path, args: &[&str]) -> String {
        let o = command(dir, args);
        assert!(o.status.success(), "git {args:?}");
        String::from_utf8_lossy(&o.stdout).into_owned()
    }

    pub(crate) fn repo(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("a.txt"), "a").unwrap();
        git(dir, &["add", "a.txt"]);
        git(dir, &["commit", "-q", "-m", "init"]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;

    #[test]
    fn valid_shas() {
        assert!(valid_sha("e9aa2fd"));
        assert!(valid_sha(&"a".repeat(40)));
        assert!(!valid_sha("abc"));
        assert!(!valid_sha("HEAD"));
        assert!(!valid_sha("e9aa2fd; rm -rf /"));
        assert!(!valid_sha("E9AA2FD"));
        assert!(!valid_sha(&"a".repeat(65)));
    }

    #[tokio::test]
    async fn run_reports_a_missing_folder_as_not_found() {
        let e = run(
            &LocalTransport,
            "/nonexistent/herdr-git",
            &format!("{GIT} status"),
            &[],
        )
        .await
        .err()
        .unwrap();
        assert_eq!(e.code, "not_found");
    }

    #[test]
    fn failed_carries_stderr_or_the_status() {
        let o = ExecOutput {
            status: 128,
            stdout: String::new(),
            stderr: "fatal: bad revision\n".into(),
        };
        assert_eq!(failed(&o).message, "fatal: bad revision");
        let o = ExecOutput {
            status: 2,
            stdout: String::new(),
            stderr: String::new(),
        };
        assert_eq!(failed(&o).message, "git exited with status 2");
        assert_eq!(failed(&o).code, "git");
    }
}
