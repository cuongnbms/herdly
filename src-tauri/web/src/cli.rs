//! Command line: `serve`, `pair`, `devices`, `revoke`.
use crate::app::{router, AppState, Config};
use crate::auth::{list_devices, revoke, start_pairing, Auth};
use crate::backend::Core;
use crate::chat::ChatHub;
use crate::config::{now_secs, REVOKE_CHECK};
use crate::hub::{forward_statuses, Hub};
use crate::store::Store;
use clap::{Args, Parser, Subcommand};
use herdly_core::machines::MachineManager;
use herdly_core::transcript::ChatManager;
use qrcode::render::unicode;
use qrcode::QrCode;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpListener;

#[derive(Parser)]
#[command(name = "herdly-web", args_conflicts_with_subcommands = true)]
pub struct Cli {
    #[command(subcommand)]
    pub cmd: Option<Cmd>,
    #[command(flatten)]
    pub serve: ServeArgs,
}

#[derive(Subcommand)]
pub enum Cmd {
    Serve(ServeArgs),
    Pair(PairArgs),
    Devices(StateArg),
    Revoke {
        id: String,
        #[command(flatten)]
        state: StateArg,
    },
}

#[derive(Args)]
pub struct ServeArgs {
    #[arg(long, default_value = crate::config::DEFAULT_BIND)]
    pub bind: String,
    #[arg(long)]
    pub origin: Option<String>,
    #[arg(long = "static")]
    pub static_dir: Option<PathBuf>,
    #[arg(long)]
    pub state: Option<PathBuf>,
}

#[derive(Args)]
pub struct PairArgs {
    #[arg(long, default_value = crate::config::DEFAULT_BIND)]
    pub bind: String,
    #[arg(long)]
    pub origin: Option<String>,
    #[arg(long)]
    pub state: Option<PathBuf>,
}

#[derive(Args)]
pub struct StateArg {
    #[arg(long)]
    pub state: Option<PathBuf>,
}

pub fn state_dir(arg: Option<PathBuf>) -> PathBuf {
    if let Some(p) = arg {
        return p;
    }
    let var = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty());
    match var("XDG_STATE_HOME") {
        Some(x) => PathBuf::from(x).join("herdly-web"),
        None => PathBuf::from(var("HOME").unwrap_or_default()).join(".local/state/herdly-web"),
    }
}

pub fn origin_for(bind: &str, origin: Option<String>) -> String {
    origin.unwrap_or_else(|| format!("http://{bind}"))
}

pub async fn build_serve(args: &ServeArgs) -> Result<(TcpListener, Arc<AppState>), String> {
    let dir = args.static_dir.clone().ok_or("--static is required")?;
    if !dir.join("index.html").is_file() {
        return Err(format!("{} has no index.html", dir.display()));
    }
    let listener = TcpListener::bind(&args.bind)
        .await
        .map_err(|e| format!("cannot bind {}: {e}", args.bind))?;
    let state = state_dir(args.state.clone());
    let store = Store::open(&state)
        .map_err(|e| format!("cannot open state dir {}: {e}", state.display()))?;

    // Mirrors the desktop startup in src-tauri/src/lib.rs.
    let (hub, statuses) = Hub::new();
    let mgr = MachineManager::new(state.join("machines.json"), hub.emit());
    let chats = Arc::new(ChatManager::default());
    mgr.set_chat_manager(chats.clone());
    let core = Arc::new(Core {
        mgr: mgr.clone(),
        chats,
    });
    let chat_hub = ChatHub::new(core.clone());
    tokio::spawn(forward_statuses(statuses, chat_hub.clone()));
    tokio::spawn(async move { mgr.connect_at_startup().await });

    let st = Arc::new(AppState {
        backend: core,
        auth: Arc::new(Auth::new(store)),
        cfg: Config {
            origin: origin_for(&args.bind, args.origin.clone()),
            static_dir: dir,
            revoke_check: REVOKE_CHECK,
        },
        hub,
        chats: chat_hub,
    });
    Ok((listener, st))
}

pub fn run(cli: Cli) -> Result<(), String> {
    match cli.cmd.unwrap_or(Cmd::Serve(cli.serve)) {
        Cmd::Serve(a) => serve(a),
        Cmd::Pair(a) => pair(a),
        Cmd::Devices(a) => devices(a),
        Cmd::Revoke { id, state } => revoke_device(&id, state),
    }
}

fn serve(args: ServeArgs) -> Result<(), String> {
    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    rt.block_on(async {
        let (listener, st) = build_serve(&args).await?;
        tracing::info!("herdly-web listening on {}", args.bind);
        axum::serve(listener, router(st))
            .await
            .map_err(|e| e.to_string())
    })
}

fn open_store(state: Option<PathBuf>) -> Result<Store, String> {
    let dir = state_dir(state);
    Store::open(&dir).map_err(|e| format!("cannot open state dir {}: {e}", dir.display()))
}

fn pair(args: PairArgs) -> Result<(), String> {
    let store = open_store(args.state)?;
    let token = start_pairing(&store, now_secs()).map_err(|e| e.to_string())?;
    let url = format!("{}/pair?t={token}", origin_for(&args.bind, args.origin));
    println!("{url}");
    let code = QrCode::new(url.as_bytes()).map_err(|e| e.to_string())?;
    println!(
        "{}",
        code.render::<unicode::Dense1x2>().quiet_zone(true).build()
    );
    println!("expires in 10 minutes");
    Ok(())
}

fn devices(args: StateArg) -> Result<(), String> {
    let store = open_store(args.state)?;
    for d in list_devices(&store).map_err(|e| e.to_string())? {
        println!(
            "{}  {}  created {}  last seen {}",
            d.id,
            d.name,
            rfc3339(d.created),
            rfc3339(d.last_seen)
        );
    }
    Ok(())
}

fn revoke_device(id: &str, args: StateArg) -> Result<(), String> {
    let store = open_store(args.state)?;
    if revoke(&store, id).map_err(|e| e.to_string())? {
        println!("revoked {id}");
        Ok(())
    } else {
        Err(format!("no device {id}"))
    }
}

/// Unix seconds as `YYYY-MM-DDTHH:MM:SSZ` (civil-from-days, proleptic Gregorian).
pub fn rfc3339(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::rfc3339;

    #[test]
    fn rfc3339_formats_known_instants() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(rfc3339(1_782_864_000 + 3_661), "2026-07-01T01:01:01Z");
    }
}
