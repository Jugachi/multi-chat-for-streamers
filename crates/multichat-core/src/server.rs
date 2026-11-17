//! HTTP + WebSocket server: serves the chat page / OBS overlay / theme editor,
//! the theme API, and pushes live events to every open page.
//!
//! WebSocket protocol (JSON text frames, `{ "event": "...", "data": ... }`):
//! - server -> client: loadConfig, serviceStatus, chatHistory, activityHistory,
//!   chatMessage, activityMessage, systemMessage, themesChanged
//! - client -> server: updateConfig, updateStreams

use crate::assets;
use crate::config::{ConfigStore, Options, Paths, DEFAULT_PORT, UI_KEYS};
use crate::hub::{encode, Hub};
use crate::platform::Platform;
use crate::services::Services;
use crate::themes::{Themes, MAX_THEME_BYTES};
use crate::virtual_mode;
use anyhow::Context;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path as UrlPath, State};
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::broadcast::error::RecvError;

struct App {
    hub: Arc<Hub>,
    services: Services,
    themes: Arc<Themes>,
    config: Arc<ConfigStore>,
    paths: Paths,
    virtual_mode: bool,
}

/// A started server. Keep it alive for as long as the app runs
/// (dropping it stops theme hot reload; the server task keeps running).
pub struct RunningServer {
    pub port: u16,
    /// `http://localhost:<port>`
    pub url: String,
    pub data_dir: std::path::PathBuf,
    _watcher: Option<notify::RecommendedWatcher>,
}

/// Binds the port, starts platform connections (or virtual mode) and serves.
/// Must be called from inside a Tokio runtime.
pub async fn start(opts: Options) -> anyhow::Result<RunningServer> {
    let paths = Paths::resolve(opts.data_dir.as_deref());
    let config = Arc::new(ConfigStore::new(paths.config_file.clone()));
    let port = opts.port.or_else(|| config.port()).unwrap_or(DEFAULT_PORT);
    // All interfaces, so OBS on a second PC can load the overlay.
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .with_context(|| format!("Port {port} is already in use. Is Multi-Chat already running? (Change it with --port=<number> or \"port\" in config.json)"))?;
    let port = listener.local_addr()?.port();

    let hub = Hub::new();
    let services = Services::new(hub.clone(), config.clone());
    let themes = Arc::new(Themes::new(paths.custom_themes.clone()));
    let watcher = themes.watch(hub.clone());

    let cfg = config.load();
    let streams: [String; 4] = Platform::ALL.map(|p| cfg.get(p.config_key()).and_then(Value::as_str).unwrap_or("").to_string());
    if opts.virtual_mode {
        virtual_mode::start(hub.clone(), services.emotes(), &streams);
    } else {
        for p in Platform::ALL {
            if !streams[p.index()].is_empty() {
                services.connect(p, &streams[p.index()]);
            }
        }
    }

    let app = Arc::new(App { hub, services, themes, config, paths: paths.clone(), virtual_mode: opts.virtual_mode });
    let router = Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/themes", get(list_themes).post(save_theme))
        .route("/api/themes/{id}", delete(delete_theme))
        .route("/custom-themes/{file}", get(custom_theme))
        .fallback(static_file)
        .with_state(app.clone());

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await {
            eprintln!("Server stopped: {e}");
        }
    });

    let url = format!("http://localhost:{port}");
    println!("Multi-Chat running on {url}");
    println!("Data folder: {}", paths.data_dir.display());
    if opts.virtual_mode {
        println!("Virtual mode: simulated chat, no connections to any platform.");
    } else if !app.hub.has_any_stream() {
        println!("First-time setup: open {url} and enter your channels in the welcome popup.");
    }
    Ok(RunningServer { port, url, data_dir: paths.data_dir, _watcher: watcher })
}

// ---------- WebSocket ----------

async fn ws_handler(ws: WebSocketUpgrade, State(app): State<Arc<App>>) -> Response {
    ws.on_upgrade(move |socket| client_session(socket, app))
}

async fn client_session(socket: WebSocket, app: Arc<App>) {
    // Subscribe before taking the snapshot so nothing falls in between.
    let mut events = app.hub.subscribe();
    let (mut sink, mut incoming) = socket.split();

    for msg in initial_messages(&app) {
        if sink.send(WsMessage::Text(msg.to_string().into())).await.is_err() {
            return;
        }
    }

    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(text) => {
                    if sink.send(WsMessage::Text(text.to_string().into())).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => continue, // slow client: skip what it missed
                Err(RecvError::Closed) => break,
            },
            msg = incoming.next() => match msg {
                Some(Ok(WsMessage::Text(text))) => handle_client_message(&app, text.as_str()),
                Some(Ok(WsMessage::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
        }
    }
}

fn config_payload(app: &App, cfg: Map<String, Value>, needs_setup: bool, with_streams: bool) -> Value {
    let mut payload = cfg;
    payload.insert("streamerName".into(), app.hub.stream(Platform::Twitch).into());
    payload.insert("needsSetup".into(), needs_setup.into());
    if with_streams {
        payload.extend(app.hub.streams_payload());
    }
    Value::Object(payload)
}

fn initial_messages(app: &App) -> Vec<Arc<str>> {
    let needs_setup = !app.virtual_mode && !app.hub.has_any_stream();
    let (messages, activities) = app.hub.history();
    let mut out = vec![
        encode("loadConfig", config_payload(app, app.config.load(), needs_setup, true)),
        encode("serviceStatus", app.hub.status_json()),
        encode("chatHistory", messages),
        encode("activityHistory", activities),
    ];
    if app.virtual_mode {
        out.push(encode("systemMessage", json!({ "text": "Virtual mode: simulated chat active", "platform": "virtual", "id": "dev" })));
    } else {
        for p in app.hub.connected_platforms() {
            out.push(encode("systemMessage", app.hub.connected_message(p)));
        }
    }
    out
}

fn handle_client_message(app: &App, text: &str) {
    let Ok(msg) = serde_json::from_str::<Value>(text) else { return };
    let data = msg.get("data").cloned().unwrap_or(Value::Null);
    match msg.get("event").and_then(Value::as_str) {
        Some("updateConfig") => {
            let Value::Object(changes) = data else { return };
            let cfg = app.config.update(|cfg| {
                for (k, v) in changes {
                    if UI_KEYS.contains(&k.as_str()) {
                        cfg.insert(k, v);
                    }
                }
            });
            app.hub.emit("loadConfig", config_payload(app, cfg, false, false));
        }
        Some("updateStreams") => {
            let streams: [String; 4] = Platform::ALL.map(|p| Services::normalize(p, data.get(p.key()).and_then(Value::as_str).unwrap_or("")));
            let cfg = app.config.update(|cfg| {
                for p in Platform::ALL {
                    cfg.insert(p.config_key().into(), streams[p.index()].clone().into());
                }
            });
            if app.virtual_mode {
                virtual_mode::set_streams(&app.hub, &streams);
            } else {
                for p in Platform::ALL {
                    if streams[p.index()] != app.hub.stream(p) {
                        app.services.connect(p, &streams[p.index()]);
                    }
                }
            }
            app.hub.emit("loadConfig", config_payload(app, cfg, false, true));
        }
        _ => {}
    }
}

// ---------- Theme API ----------

async fn list_themes(State(app): State<Arc<App>>) -> Response {
    Json(app.themes.list()).into_response()
}

#[derive(Deserialize)]
struct SaveTheme {
    name: Option<String>,
    css: String,
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

/// The server listens on all interfaces (OBS may run on another PC), so only
/// allow changes to theme files from this machine.
fn is_local(addr: &SocketAddr) -> bool {
    addr.ip().to_canonical().is_loopback()
}

const LOCAL_ONLY: &str = "Themes can only be changed from the computer running Multi-Chat.";

async fn save_theme(ConnectInfo(addr): ConnectInfo<SocketAddr>, State(app): State<Arc<App>>, Json(body): Json<SaveTheme>) -> Response {
    if !is_local(&addr) {
        return error(StatusCode::FORBIDDEN, LOCAL_ONLY);
    }
    if body.css.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "Theme CSS is empty.");
    }
    if body.css.len() > MAX_THEME_BYTES {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Theme is too large (max 200 KB).");
    }
    match app.themes.save(body.name.as_deref().unwrap_or(""), &body.css) {
        Ok(info) => Json(json!({ "id": info.id, "name": info.name, "url": info.url })).into_response(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn delete_theme(ConnectInfo(addr): ConnectInfo<SocketAddr>, State(app): State<Arc<App>>, UrlPath(id): UrlPath<String>) -> Response {
    if !is_local(&addr) {
        return error(StatusCode::FORBIDDEN, LOCAL_ONLY);
    }
    match app.themes.delete(&id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => error(StatusCode::BAD_REQUEST, &e),
    }
}

async fn custom_theme(State(app): State<Arc<App>>, UrlPath(file): UrlPath<String>) -> Response {
    match app.themes.custom_file(&file).and_then(|p| std::fs::read(p).ok()) {
        Some(bytes) => file_response(bytes, "text/css; charset=utf-8".into()),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

// ---------- Static files ----------

/// Serves `<data dir>/web/<path>` if it exists (user overrides), else the built-in file.
async fn static_file(State(app): State<Arc<App>>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() || path.ends_with('/') { format!("{path}index.html") } else { path.to_string() };
    if path.split('/').any(|seg| seg == ".." || seg.contains('\\')) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let override_file = app.paths.web_override.join(&path);
    if override_file.is_file() {
        if let Ok(bytes) = std::fs::read(&override_file) {
            let mime = mime_guess::from_path(&path).first_or_octet_stream().to_string();
            return file_response(bytes, mime);
        }
    }
    match assets::get(&path) {
        Some((bytes, mime)) => file_response(bytes, mime),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn file_response(bytes: Vec<u8>, mime: String) -> Response {
    let mime = if mime.starts_with("text/") || mime.contains("javascript") {
        if mime.contains("charset") { mime } else { format!("{mime}; charset=utf-8") }
    } else {
        mime
    };
    // no-cache: themes and pages hot-reload, browsers must revalidate.
    ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "no-cache".to_string())], bytes).into_response()
}
