//! End-to-end: start the real server (virtual mode, random port, temp data dir)
//! and talk to it over HTTP and WebSocket like the browser does.

use futures_util::{SinkExt, StreamExt};
use multichat_core::Options;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

async fn start() -> (multichat_core::RunningServer, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("multichat-test-{}", fastrand::u64(..)));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("config.json"), r#"{ "twitchChannel": "Jugachi", "theme": "mmo-log", "custom": 1 }"#).unwrap();
    let server = multichat_core::start(Options { virtual_mode: true, port: Some(0), data_dir: Some(dir.clone()) })
        .await
        .expect("server starts");
    (server, dir)
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Reads frames until one with `event` arrives.
async fn next_event(ws: &mut Ws, event: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let Some(Ok(Message::Text(text))) = ws.next().await else { panic!("socket closed") };
            let msg: Value = serde_json::from_str(text.as_str()).unwrap();
            if msg["event"] == event {
                return msg["data"].clone();
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {event}"))
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_pages_and_streams_events() {
    let (server, dir) = start().await;
    let base = server.url.clone();
    let http = reqwest::Client::new();

    // Static files (embedded) with correct types
    let page = http.get(format!("{base}/")).send().await.unwrap();
    assert_eq!(page.status(), 200);
    assert!(page.headers()["content-type"].to_str().unwrap().starts_with("text/html"));
    assert!(page.text().await.unwrap().contains("/js/main.js"));
    let js = http.get(format!("{base}/js/socket.js")).send().await.unwrap();
    assert!(js.headers()["content-type"].to_str().unwrap().contains("javascript"));
    assert_eq!(http.get(format!("{base}/nope.html")).send().await.unwrap().status(), 404);
    assert_eq!(http.get(format!("{base}/../config.json")).send().await.unwrap().status(), 404);

    // User override of a web file
    std::fs::create_dir_all(dir.join("web")).unwrap();
    std::fs::write(dir.join("web/editor.html"), "custom editor").unwrap();
    assert_eq!(http.get(format!("{base}/editor.html")).send().await.unwrap().text().await.unwrap(), "custom editor");

    // WebSocket: initial state
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://localhost:{}/ws", server.port)).await.unwrap();
    let config = next_event(&mut ws, "loadConfig").await;
    assert_eq!(config["theme"], "mmo-log");
    assert_eq!(config["activeTwitch"], "Jugachi");
    assert_eq!(config["streamerName"], "Jugachi");
    assert_eq!(config["needsSetup"], false);
    let status = next_event(&mut ws, "serviceStatus").await;
    let keys: Vec<&String> = status.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["twitch", "youtube", "kick", "tiktok"]);
    assert_eq!(status["twitch"]["state"], "connected");
    assert_eq!(status["twitch"]["virtual"], true);
    assert_eq!(status["kick"]["channel"], "virtual-kick");
    next_event(&mut ws, "chatHistory").await;
    let toast = next_event(&mut ws, "systemMessage").await;
    assert_eq!(toast["platform"], "virtual");

    // Virtual chat keeps flowing
    let chat = next_event(&mut ws, "chatMessage").await;
    assert!(["Twitch", "YouTube", "Kick", "TikTok"].contains(&chat["platform"].as_str().unwrap()));

    // updateConfig only accepts UI keys and keeps unknown config keys
    ws.send(Message::text(json!({ "event": "updateConfig", "data": { "theme": "neon-tag", "port": 1 } }).to_string())).await.unwrap();
    let config = next_event(&mut ws, "loadConfig").await;
    assert_eq!(config["theme"], "neon-tag");
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("config.json")).unwrap()).unwrap();
    assert_eq!(saved["theme"], "neon-tag");
    assert!(saved.get("port").is_none());
    assert_eq!(saved["custom"], 1);

    // updateStreams normalizes input and stays virtual
    ws.send(Message::text(json!({ "event": "updateStreams", "data": { "twitch": "jugachi", "kick": "https://kick.com/SomeOne", "tiktok": "@cool.user", "youtube": "" } }).to_string())).await.unwrap();
    let config = next_event(&mut ws, "loadConfig").await;
    assert_eq!(config["activeKick"], "someone");
    assert_eq!(config["activeTikTok"], "cool.user");
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("config.json")).unwrap()).unwrap();
    assert_eq!(saved["kickChannel"], "someone");

    // Theme API + hot reload event
    let themes: Vec<Value> = http.get(format!("{base}/api/themes")).send().await.unwrap().json().await.unwrap();
    assert!(themes.iter().any(|t| t["id"] == "rpg-dialog" && t["name"] == "RPG Dialog (Typewriter)"));
    let res = http
        .post(format!("{base}/api/themes"))
        .json(&json!({ "name": "Test Theme ✨", "css": ".message { color: red; }" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let saved: Value = res.json().await.unwrap();
    assert_eq!(saved["id"], "custom-test-theme");
    let changed = next_event(&mut ws, "themesChanged").await;
    assert!(changed["themes"].as_array().unwrap().iter().any(|t| t["id"] == "custom-test-theme"));
    let css = http.get(format!("{base}/custom-themes/test-theme.css")).send().await.unwrap().text().await.unwrap();
    assert_eq!(css, "/* @name: Test Theme ✨ */\n.message { color: red; }");
    assert_eq!(http.delete(format!("{base}/api/themes/custom-test-theme")).send().await.unwrap().status(), 200);
    assert_eq!(http.delete(format!("{base}/api/themes/dark-pill")).send().await.unwrap().status(), 400);
    let empty = http.post(format!("{base}/api/themes")).json(&json!({ "name": "x", "css": "  " })).send().await.unwrap();
    assert_eq!(empty.status(), 400);

    drop(ws);
    let _ = std::fs::remove_dir_all(dir);
}
