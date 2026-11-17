//! Shared state between the platform services and the connected browsers:
//! chat/activity history, active channels, per-service connection status.
//! Every change is broadcast to all WebSocket clients as `{ event, data }`.

use crate::platform::Platform;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

const MAX_HISTORY: usize = 1000;
const MAX_ACTIVITY_HISTORY: usize = 100;

/// `author` is HTML-escaped, `message` is safe HTML (may contain emote `<img>`s),
/// `color` is the chatter's name color.
#[derive(Clone, Debug, Serialize)]
pub struct ChatMessage {
    pub platform: &'static str,
    pub author: String,
    pub message: String,
    pub color: String,
}

/// `kind` picks the SVG icon on the client: sub, resub, gift, bits, raid, host,
/// follow, superchat, member. `text` is plain text (rendered with textContent).
#[derive(Clone, Debug, Serialize)]
pub struct Activity {
    pub platform: &'static str,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnState {
    Off,
    Connecting,
    Connected,
    Retrying,
    Error,
}

#[derive(Clone, Debug, Serialize)]
pub struct ServiceStatus {
    pub name: &'static str,
    pub state: ConnState,
    pub channel: String,
    #[serde(rename = "virtual")]
    pub is_virtual: bool,
    pub detail: String,
}

struct Inner {
    messages: VecDeque<ChatMessage>,
    activities: VecDeque<Activity>,
    streams: [String; 4],
    status: [ServiceStatus; 4],
}

pub struct Hub {
    inner: Mutex<Inner>,
    tx: broadcast::Sender<Arc<str>>,
}

/// Serializes a socket event once so it can be fanned out to every client.
pub fn encode(event: &str, data: impl Serialize) -> Arc<str> {
    json!({ "event": event, "data": data }).to_string().into()
}

impl Hub {
    pub fn new() -> Arc<Hub> {
        let (tx, _) = broadcast::channel(1024);
        let status = Platform::ALL.map(|p| ServiceStatus {
            name: p.name(),
            state: ConnState::Off,
            channel: String::new(),
            is_virtual: false,
            detail: String::new(),
        });
        Arc::new(Hub {
            inner: Mutex::new(Inner {
                messages: VecDeque::new(),
                activities: VecDeque::new(),
                streams: Default::default(),
                status,
            }),
            tx,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<str>> {
        self.tx.subscribe()
    }

    pub fn emit(&self, event: &str, data: impl Serialize) {
        // No receivers is fine (nobody has the page open).
        let _ = self.tx.send(encode(event, data));
    }

    pub fn chat(&self, msg: ChatMessage) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.messages.push_back(msg.clone());
            if inner.messages.len() > MAX_HISTORY {
                inner.messages.pop_front();
            }
        }
        self.emit("chatMessage", msg);
    }

    pub fn activity(&self, activity: Activity) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.activities.push_back(activity.clone());
            if inner.activities.len() > MAX_ACTIVITY_HISTORY {
                inner.activities.pop_front();
            }
        }
        self.emit("activityMessage", activity);
    }

    pub fn history(&self) -> (Vec<ChatMessage>, Vec<Activity>) {
        let inner = self.inner.lock().unwrap();
        (inner.messages.iter().cloned().collect(), inner.activities.iter().cloned().collect())
    }

    // ---- connection status ----

    /// `{ "twitch": {...}, "youtube": {...}, ... }` in a fixed order.
    pub fn status_json(&self) -> Value {
        let inner = self.inner.lock().unwrap();
        let mut map = Map::new();
        for p in Platform::ALL {
            map.insert(p.key().into(), serde_json::to_value(&inner.status[p.index()]).unwrap_or_default());
        }
        Value::Object(map)
    }

    pub fn status(&self, platform: Platform) -> ServiceStatus {
        self.inner.lock().unwrap().status[platform.index()].clone()
    }

    pub fn update_status(&self, platform: Platform, change: impl FnOnce(&mut ServiceStatus)) {
        change(&mut self.inner.lock().unwrap().status[platform.index()]);
        self.emit("serviceStatus", self.status_json());
    }

    /// Changes state + detail, keeps channel and virtual flag.
    pub fn set_state(&self, platform: Platform, state: ConnState, detail: impl Into<String>) {
        let detail = detail.into();
        self.update_status(platform, |s| {
            s.state = state;
            s.detail = detail;
        });
    }

    pub fn connected_message(&self, platform: Platform) -> Value {
        let s = self.status(platform);
        json!({ "text": format!("Connected to {}: {}", s.name, s.channel), "platform": s.name, "id": platform.key() })
    }

    /// Toast shown once per browser tab when a service connects.
    pub fn announce_connected(&self, platform: Platform) {
        self.emit("systemMessage", self.connected_message(platform));
    }

    pub fn connected_platforms(&self) -> Vec<Platform> {
        let inner = self.inner.lock().unwrap();
        Platform::ALL.into_iter().filter(|p| inner.status[p.index()].state == ConnState::Connected).collect()
    }

    // ---- active channels ----

    pub fn stream(&self, platform: Platform) -> String {
        self.inner.lock().unwrap().streams[platform.index()].clone()
    }

    pub fn set_stream(&self, platform: Platform, channel: &str) {
        self.inner.lock().unwrap().streams[platform.index()] = channel.to_string();
    }

    pub fn has_any_stream(&self) -> bool {
        self.inner.lock().unwrap().streams.iter().any(|s| !s.is_empty())
    }

    /// `{ activeTwitch, activeYouTube, activeKick, activeTikTok }` for the client.
    pub fn streams_payload(&self) -> Map<String, Value> {
        let inner = self.inner.lock().unwrap();
        Platform::ALL
            .into_iter()
            .map(|p| (p.active_key().to_string(), Value::String(inner.streams[p.index()].clone())))
            .collect()
    }
}
