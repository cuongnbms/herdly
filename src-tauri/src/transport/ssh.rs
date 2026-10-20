use super::local::LocalTransport;
use super::{exec, secure_runtime_dir, sh_quote, socket_name, SessionEntry, Transport};
use crate::error::{AppError, AppResult};
use async_trait::async_trait;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Runs herdr on a remote Machine through one shared ssh ControlMaster connection.
pub struct SshTransport {
    pub machine_id: String,
    pub target: String,
    pub ctl: PathBuf,
    /// Active forwards: session name -> (remote socket, local socket).
    forwards: Mutex<HashMap<String, (String, PathBuf)>>,
    /// Serializes forward/cancel so concurrent callers never double-forward.
    gate: tokio::sync::Mutex<()>,
}

/// The cached local path if it still forwards `remote` and the socket file exists.
fn reusable(
    cached: Option<&(String, PathBuf)>,
    remote: &str,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    cached
        .filter(|(r, p)| r == remote && exists(p))
        .map(|(_, p)| p.clone())
}

impl SshTransport {
    /// Builds the transport, securing the runtime dir that holds the control socket.
    pub fn new(machine_id: &str, target: &str) -> AppResult<SshTransport> {
        let ctl = secure_runtime_dir()?.join(format!("{machine_id}.ctl"));
        Ok(SshTransport {
            machine_id: machine_id.into(),
            target: target.into(),
            ctl,
            forwards: Mutex::new(HashMap::new()),
            gate: tokio::sync::Mutex::new(()),
        })
    }

    /// Drop the forward cache (the master restarted, so its forwards are gone).
    pub fn forget_forwards(&self) {
        self.forwards.lock().unwrap().clear();
    }

    /// `ssh -S ctl -O <op> -L <local>:<remote> target`; the -L spec is one literal argv element.
    fn forward_argv(&self, op: &str, local: &Path, session: &SessionEntry) -> Vec<String> {
        vec![
            "ssh".into(),
            "-S".into(),
            self.ctl.to_string_lossy().into_owned(),
            "-o".into(),
            "BatchMode=yes".into(),
            "-O".into(),
            op.into(),
            "-L".into(),
            format!("{}:{}", local.display(), session.socket),
            self.target.clone(),
        ]
    }
}

/// `ssh -S ctl -o BatchMode=yes [-tt] target '<quoted argv>'`; the remote command is one argument.
pub fn ssh_wrap(ctl: &Path, target: &str, argv: &[String], tty: bool) -> Vec<String> {
    let mut v: Vec<String> = vec![
        "ssh".into(),
        "-S".into(),
        ctl.to_string_lossy().into_owned(),
        "-o".into(),
        "BatchMode=yes".into(),
    ];
    if tty {
        v.push("-tt".into());
    }
    v.push(target.into());
    v.push(
        argv.iter()
            .map(|a| sh_quote(a))
            .collect::<Vec<_>>()
            .join(" "),
    );
    v
}

#[async_trait]
impl Transport for SshTransport {
    fn wrap(&self, argv: &[String], tty: bool) -> Vec<String> {
        ssh_wrap(&self.ctl, &self.target, argv, tty)
    }

    async fn local_socket(&self, session: &SessionEntry) -> AppResult<PathBuf> {
        let _gate = self.gate.lock().await;
        let hit = reusable(
            self.forwards.lock().unwrap().get(&session.name),
            &session.socket,
            |p| p.exists(),
        );
        if let Some(p) = hit {
            return Ok(p);
        }
        let local = secure_runtime_dir()?.join(socket_name(&self.machine_id, &session.name));
        // The master may still hold an identical forward (inherited from a crashed run or
        // after our cache was dropped); it would ack a re-forward without re-binding the socket.
        let _ = exec(
            &LocalTransport,
            &self.forward_argv("cancel", &local, session),
        )
        .await;
        match std::fs::remove_file(&local) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        let out = exec(
            &LocalTransport,
            &self.forward_argv("forward", &local, session),
        )
        .await?;
        if out.status != 0 {
            return Err(classify_ssh_error(&out.stderr));
        }
        self.forwards.lock().unwrap().insert(
            session.name.clone(),
            (session.socket.clone(), local.clone()),
        );
        Ok(local)
    }

    async fn release_socket(&self, session: &SessionEntry) -> AppResult<()> {
        let _gate = self.gate.lock().await;
        self.forwards.lock().unwrap().remove(&session.name);
        let local = secure_runtime_dir()?.join(socket_name(&self.machine_id, &session.name));
        let out = exec(
            &LocalTransport,
            &self.forward_argv("cancel", &local, session),
        )
        .await;
        // The socket file must not outlive the release, whatever ssh said.
        let _ = std::fs::remove_file(&local);
        let out = out?;
        if out.status != 0 {
            return Err(classify_ssh_error(&out.stderr));
        }
        Ok(())
    }

    /// No `-O cancel`: the master's `-O exit` that follows drops every forward.
    async fn forget_socket(&self, session: &SessionEntry) -> AppResult<()> {
        let _gate = self.gate.lock().await;
        self.forwards.lock().unwrap().remove(&session.name);
        let local = secure_runtime_dir()?.join(socket_name(&self.machine_id, &session.name));
        let _ = std::fs::remove_file(&local);
        Ok(())
    }
}

/// `ssh -M -S ctl -o ControlPersist=yes -o ServerAliveInterval=5 -o ServerAliveCountMax=3
/// [-o BatchMode=yes] -f -N target`. Keepalives make a wedged connection end the master
/// (about 15 s) instead of leaving the Machine "connected" with frozen terminals.
pub fn master_argv(ctl: &Path, target: &str, batch: bool) -> Vec<String> {
    let mut v: Vec<String> = vec![
        "ssh".into(),
        "-M".into(),
        "-S".into(),
        ctl.to_string_lossy().into_owned(),
        "-o".into(),
        "ControlPersist=yes".into(),
        "-o".into(),
        "ServerAliveInterval=5".into(),
        "-o".into(),
        "ServerAliveCountMax=3".into(),
    ];
    if batch {
        v.push("-o".into());
        v.push("BatchMode=yes".into());
    }
    v.extend(["-f".into(), "-N".into(), target.into()]);
    v
}

fn control_argv(ctl: &Path, target: &str, op: &str) -> Vec<String> {
    vec![
        "ssh".into(),
        "-S".into(),
        ctl.to_string_lossy().into_owned(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-O".into(),
        op.into(),
        target.into(),
    ]
}

/// True when the ControlMaster for `ctl` is running (`ssh -O check` exits 0).
pub async fn master_alive(ctl: &Path, target: &str) -> bool {
    matches!(exec(&LocalTransport, &control_argv(ctl, target, "check")).await, Ok(o) if o.status == 0)
}

/// How long `link_alive` waits for the remote to answer.
const LINK_PROBE: std::time::Duration = std::time::Duration::from_secs(5);

/// True when `true` run through the master answers within `LINK_PROBE`. Unlike `-O check`
/// this crosses the network, so it fails while the master's TCP is dead but not yet noticed
/// (as after the Mac slept).
pub async fn link_alive(ctl: &Path, target: &str) -> bool {
    answers(&ssh_wrap(ctl, target, &["true".into()], false), LINK_PROBE).await
}

/// True when `argv` exits 0 within `within`; a slower one is killed.
async fn answers(argv: &[String], within: std::time::Duration) -> bool {
    matches!(
        tokio::time::timeout(within, exec(&LocalTransport, argv)).await,
        Ok(Ok(o)) if o.status == 0
    )
}

/// Ask the ControlMaster to exit; errors are ignored.
pub async fn master_exit(ctl: &Path, target: &str) {
    let _ = exec(&LocalTransport, &control_argv(ctl, target, "exit")).await;
}

/// Remove a control socket file left behind by a dead master (ssh would refuse to reuse it).
pub async fn clear_stale_ctl(ctl: &Path, target: &str) {
    if ctl.exists() && !master_alive(ctl, target).await {
        let _ = std::fs::remove_file(ctl);
    }
}

/// Start a master with `argv` (`ssh -f` forks, so the daemon inherits our descriptors):
/// stdin and stdout are null and stderr goes to `errfile`, never a pipe we would read to EOF.
/// Waits (30 s) for the foreground process only, then classifies a failure from `errfile`.
pub async fn run_detached(argv: &[String], errfile: &Path) -> AppResult<()> {
    let program = argv
        .first()
        .ok_or_else(|| AppError::new("invalid", "empty command"))?;
    let err = std::fs::File::create(errfile)?;
    let mut child = tokio::process::Command::new(program)
        .args(&argv[1..])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(err)
        .kill_on_drop(true)
        .spawn()?;
    let waited = tokio::time::timeout(std::time::Duration::from_secs(30), child.wait()).await;
    let text = std::fs::read_to_string(errfile).unwrap_or_default();
    let _ = std::fs::remove_file(errfile);
    match waited {
        Err(_) => Err(AppError::new(
            "timeout",
            format!("{program} took longer than 30s"),
        )),
        Ok(Err(e)) => Err(e.into()),
        Ok(Ok(st)) if st.success() => Ok(()),
        Ok(Ok(st)) => {
            let e = classify_ssh_error(&text);
            Err(if text.trim().is_empty() {
                AppError::new("io", format!("ssh exited with {st}"))
            } else {
                e
            })
        }
    }
}

/// Start the batch (non-interactive) ControlMaster for `ctl`.
pub async fn start_master(machine_id: &str, ctl: &Path, target: &str) -> AppResult<()> {
    let errfile = secure_runtime_dir()?.join(format!("{machine_id}-master.err"));
    run_detached(&master_argv(ctl, target, true), &errfile).await
}

pub fn classify_ssh_error(stderr: &str) -> AppError {
    if stderr.contains("Permission denied")
        || stderr.contains("Host key verification failed")
        || stderr.contains("passphrase")
    {
        return AppError::new("ssh_auth", stderr.trim());
    }
    if stderr.contains("administratively prohibited") || stderr.contains("open failed") {
        return AppError::new(
            "ssh_forward_denied",
            "the remote sshd refuses Unix socket forwarding (AllowStreamLocalForwarding)",
        );
    }
    let last = stderr
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or("ssh failed");
    AppError::new("io", last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    #[test]
    fn wraps_with_quoting() {
        let argv: Vec<String> = [
            "tail",
            "-n",
            "+1",
            "-F",
            "/home/u/.claude/projects/-x/it's a file.jsonl",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let w = ssh_wrap(
            Path::new("/tmp/herdly-501/devtuf.ctl"),
            "devtuf",
            &argv,
            false,
        );
        assert_eq!(
            w[..6],
            [
                "ssh",
                "-S",
                "/tmp/herdly-501/devtuf.ctl",
                "-o",
                "BatchMode=yes",
                "devtuf"
            ]
        );
        assert_eq!(w.len(), 7);
        assert_eq!(
            w[6],
            "'tail' '-n' '+1' '-F' '/home/u/.claude/projects/-x/it'\\''s a file.jsonl'"
        );
        let t = ssh_wrap(Path::new("/c"), "u@h", &["herdr".into()], true);
        assert!(t.contains(&"-tt".to_string()));
    }
    #[test]
    fn master_argv_batch_and_interactive() {
        let b = master_argv(Path::new("/c"), "devtuf", true);
        assert_eq!(
            b,
            [
                "ssh",
                "-M",
                "-S",
                "/c",
                "-o",
                "ControlPersist=yes",
                "-o",
                "ServerAliveInterval=5",
                "-o",
                "ServerAliveCountMax=3",
                "-o",
                "BatchMode=yes",
                "-f",
                "-N",
                "devtuf"
            ]
        );
        let i = master_argv(Path::new("/c"), "devtuf", false);
        assert_eq!(
            i,
            [
                "ssh",
                "-M",
                "-S",
                "/c",
                "-o",
                "ControlPersist=yes",
                "-o",
                "ServerAliveInterval=5",
                "-o",
                "ServerAliveCountMax=3",
                "-f",
                "-N",
                "devtuf"
            ]
        );
    }
    #[test]
    fn reuses_cached_forward_only_when_valid() {
        let c = ("/r/herdr.sock".to_string(), PathBuf::from("/l/a.sock"));
        assert_eq!(
            reusable(Some(&c), "/r/herdr.sock", |_| true),
            Some(PathBuf::from("/l/a.sock"))
        );
        assert_eq!(reusable(Some(&c), "/r/other.sock", |_| true), None);
        assert_eq!(reusable(Some(&c), "/r/herdr.sock", |_| false), None);
        assert_eq!(reusable(None, "/r/herdr.sock", |_| true), None);
    }
    #[test]
    fn control_commands_use_batch_mode() {
        let a = control_argv(Path::new("/c"), "h", "check");
        assert_eq!(
            a,
            ["ssh", "-S", "/c", "-o", "BatchMode=yes", "-O", "check", "h"]
        );
    }
    fn sh(script: &str) -> Vec<String> {
        vec!["sh".into(), "-c".into(), script.into()]
    }
    #[tokio::test]
    async fn detached_start_does_not_wait_for_the_forked_daemon() {
        let d = tempfile::tempdir().unwrap();
        let t = std::time::Instant::now();
        // The background child inherits stderr and outlives the parent, like `ssh -f`.
        run_detached(&sh("(sleep 4) & exit 0"), &d.path().join("e"))
            .await
            .unwrap();
        assert!(
            t.elapsed() < std::time::Duration::from_secs(2),
            "{:?}",
            t.elapsed()
        );
    }
    #[tokio::test]
    async fn detached_failure_is_classified_from_stderr() {
        let d = tempfile::tempdir().unwrap();
        let e = run_detached(
            &sh("echo 'u@h: Permission denied (publickey).' >&2; exit 255"),
            &d.path().join("e"),
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, "ssh_auth");
        assert!(!d.path().join("e").exists());
        let e = run_detached(&sh("exit 3"), &d.path().join("e"))
            .await
            .unwrap_err();
        assert_eq!(e.code, "io");
    }
    #[tokio::test]
    async fn the_link_answers_only_with_success_in_time() {
        let within = std::time::Duration::from_secs(5);
        assert!(answers(&sh("exit 0"), within).await);
        assert!(!answers(&sh("exit 255"), within).await);
        let t = std::time::Instant::now();
        assert!(!answers(&sh("sleep 5"), std::time::Duration::from_millis(200)).await);
        assert!(
            t.elapsed() < std::time::Duration::from_secs(2),
            "{:?}",
            t.elapsed()
        );
    }
    #[test]
    fn classifies_errors() {
        assert_eq!(
            classify_ssh_error("u@h: Permission denied (publickey).").code,
            "ssh_auth"
        );
        assert_eq!(
            classify_ssh_error("Host key verification failed.").code,
            "ssh_auth"
        );
        let f =
            classify_ssh_error("channel 2: open failed: administratively prohibited: open failed");
        assert_eq!(f.code, "ssh_forward_denied");
        assert!(f.message.contains("AllowStreamLocalForwarding"));
        assert_eq!(
            classify_ssh_error("boom\nssh: connect to host x port 22: Connection refused").message,
            "ssh: connect to host x port 22: Connection refused"
        );
    }
}
