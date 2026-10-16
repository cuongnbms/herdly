pub mod attach;
pub mod commands;
pub mod complete;
pub mod error;
pub mod files;
pub mod fonts;
pub mod git;
pub mod herdr;
pub mod layout;
pub mod machines;
pub mod mouse;
pub mod notify;
pub mod pi;
pub mod quota;
pub mod sshconfig;
pub mod transcript;
pub mod transport;
pub mod view;

use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, MenuItemKind};
use tauri::{Emitter, Manager};

use attach::AttachManager;
use machines::{MachineManager, UiEvent};
use tracing_appender::rolling::{Builder, Rotation};
use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("herdly-html", |ctx, req| {
            ctx.app_handle()
                .state::<Arc<files::html::HtmlPages>>()
                .respond(req.method(), req.uri().path())
        })
        .menu(app_menu)
        .on_menu_event(|app, e| {
            if e.id() == "quit" {
                let _ = app.emit("app://quit-requested", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_quit,
            commands::machines_list,
            commands::machine_connect,
            commands::machine_disconnect,
            commands::machine_add,
            commands::machine_remove,
            commands::machine_update,
            commands::machine_master_alive,
            commands::ssh_hosts,
            commands::connect_open,
            commands::connect_write,
            commands::connect_ack,
            commands::connect_resize,
            commands::connect_close,
            commands::sessions_refresh,
            commands::session_start,
            commands::session_stop,
            commands::session_delete,
            commands::herdr_call,
            commands::notify_pane,
            commands::image_save_temp,
            commands::term_open,
            commands::term_write,
            commands::term_resize,
            commands::term_ack,
            commands::term_release,
            commands::term_close,
            commands::chat_open,
            commands::chat_locate,
            commands::chat_fork,
            commands::chat_btw_ask,
            commands::chat_btw_cancel,
            commands::chat_btw_discard,
            commands::chat_page,
            commands::chat_image,
            commands::chat_close,
            commands::complete_commands,
            commands::complete_files,
            commands::complete_entries,
            commands::complete_dirs,
            commands::chat_git_status,
            commands::git_repo,
            commands::git_log,
            commands::git_commit_files,
            commands::files_list_dir,
            commands::files_list_all,
            commands::files_read,
            commands::files_image,
            commands::files_watch,
            commands::files_unwatch,
            commands::files_upload,
            commands::files_download,
            commands::files_create,
            commands::files_rename,
            commands::files_move,
            commands::files_delete,
            commands::files_write,
            commands::files_html_put,
            commands::files_html_drop,
            commands::system_fonts,
            commands::font_face,
            commands::quota_fetch,
            commands::pi_models_list,
            commands::layout_load,
            commands::layout_save,
        ])
        .setup(|app| {
            init_logging(app.path().app_log_dir()?)?;
            tracing::info!("herdly starting");
            notify::init(app.handle());
            mouse::init(app.handle());
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(Arc::new(layout::LayoutStore::new(
                dir.join("sidebar-layout.json"),
            )));
            let handle = app.handle().clone();
            let mgr = MachineManager::new(
                dir.join("machines.json"),
                Arc::new(move |e| {
                    let res = match e {
                        UiEvent::Machine(v) => handle.emit("sidebar://machine", v),
                        UiEvent::PaneStatus(p) => handle.emit("pane://status", p),
                    };
                    if let Err(err) = res {
                        tracing::warn!("emit failed: {err}");
                    }
                }),
            );
            let attach = AttachManager::new(std::time::Duration::from_secs(15));
            mgr.set_attach_manager(attach.clone());
            let chats = Arc::new(transcript::ChatManager::default());
            mgr.set_chat_manager(chats.clone());
            app.manage(mgr.clone());
            app.manage(attach);
            app.manage(chats);
            app.manage(transcript::btw::BtwRuns::default());
            app.manage(Arc::new(files::watch_manager::FilesWatch::default()));
            app.manage(Arc::new(files::html::HtmlPages::default()));
            tauri::async_runtime::spawn(async move { mgr.connect_at_startup().await });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // ControlPersist masters outlive us: end every ssh master on the way out.
                if let Some(mgr) = app.try_state::<Arc<MachineManager>>() {
                    let mgr = mgr.inner().clone();
                    tauri::async_runtime::block_on(async move { mgr.disconnect_all_ssh().await });
                }
            }
        });
}

/// The Quit menu item's text, named after the app as it is installed.
fn quit_label(app_name: &str) -> String {
    format!("Quit {app_name}")
}

/// The default menu minus "Close Window" (with a single window its Cmd+W quit the app), and with
/// Quit routed through the frontend so unsaved Drafts are asked about first.
fn app_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    for item in menu.items()? {
        let Some(sub) = item.as_submenu() else {
            continue;
        };
        for entry in sub.items()? {
            if let MenuItemKind::Predefined(p) = &entry {
                if p.text()? == "Close Window" {
                    sub.remove(p)?;
                } else if p.text()?.starts_with("Quit") {
                    let at = sub
                        .items()?
                        .iter()
                        .position(|i| i.id() == p.id())
                        .unwrap_or(0);
                    sub.remove(p)?;
                    let quit = MenuItem::with_id(
                        app,
                        "quit",
                        quit_label(&app.package_info().name),
                        true,
                        Some("CmdOrCtrl+Q"),
                    )?;
                    sub.insert(&quit, at)?;
                }
            }
        }
    }
    Ok(menu)
}

/// Daily-rotating log files under `dir`, keeping the 5 most recent.
fn init_logging(dir: std::path::PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(&dir)?;
    let appender = Builder::new()
        .rotation(Rotation::DAILY)
        .filename_prefix("herdly")
        .filename_suffix("log")
        .max_log_files(5)
        .build(&dir)?;
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(appender)
        .with_ansi(false)
        .try_init()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_quit_item_names_the_app() {
        assert_eq!(quit_label("Herdly"), "Quit Herdly");
    }
}
