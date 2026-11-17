//! Multi-Chat desktop app: a thin Tauri shell around `multichat-core`.
//!
//! On start it launches the built-in server (chat, OBS overlay, theme editor)
//! and opens a window on it. The window shows exactly the page OBS uses, so
//! everything is plain HTML/CSS/JS from `public/` — no separate desktop UI.
//!
//! Command line: `multi-chat [--virtual] [--port=41414] [--data-dir=<path>]`

// No console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

fn main() {
    let opts = multichat_core::Options::from_args(std::env::args().skip(1));

    tauri::Builder::default()
        // A second launch focuses the existing window instead of fighting over the port.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(move |app| {
            let started = tauri::async_runtime::block_on(multichat_core::start(opts.clone()));
            let builder = match started {
                Ok(server) => {
                    let url: tauri::Url = format!("{}/?app=1", server.url).parse()?;
                    app.manage(Mutex::new(server)); // keeps theme hot reload alive
                    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                }
                Err(e) => {
                    let message = serde_json::to_string(&format!("{e:#}"))?;
                    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                        .initialization_script(format!("window.__STARTUP_ERROR__ = {message};"))
                }
            };
            builder
                .title("Multi-Chat")
                .inner_size(1100.0, 750.0)
                .min_inner_size(360.0, 300.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Multi-Chat");
}
