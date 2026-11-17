//! Platform connections. Each platform module exposes:
//!
//! - `normalize(input) -> String`   turns user input (name, @name, URL...) into a channel id
//! - `run(ctx, channel)`            connects and keeps reconnecting until the task is aborted
//!
//! [`Services::connect`] aborts the previous task for a platform and starts a new one,
//! so switching channels never leaves an old connection behind.
//! To add a platform: add it to [`Platform`], write a module with those two
//! functions, wire it into `normalize`/`spawn_run` below, and add an icon on the client.

pub mod kick;
pub mod tiktok;
pub mod twitch;
pub mod youtube;

use crate::config::ConfigStore;
use crate::emotes::Emotes;
use crate::hub::{ConnState, Hub};
use crate::platform::Platform;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::JoinHandle;

/// Everything a platform task needs.
#[derive(Clone)]
pub struct Ctx {
    pub hub: Arc<Hub>,
    pub http: reqwest::Client,
    pub emotes: Arc<Emotes>,
    pub config: Arc<ConfigStore>,
}

impl Ctx {
    /// Marks the platform as retrying and waits before the next attempt.
    pub async fn retry_later(&self, platform: Platform, reason: &str, wait: Duration) {
        let secs = wait.as_secs();
        println!("{} {reason} Retrying in {secs}s...", platform.name());
        self.hub.set_state(platform, ConnState::Retrying, format!("{reason} Retrying in {secs}s..."));
        tokio::time::sleep(wait).await;
    }
}

pub const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .cookie_store(true)
        .timeout(Duration::from_secs(20))
        .build()
        .expect("HTTP client")
}

pub struct Services {
    ctx: Ctx,
    tasks: Mutex<HashMap<Platform, JoinHandle<()>>>,
}

impl Services {
    pub fn new(hub: Arc<Hub>, config: Arc<ConfigStore>) -> Services {
        Services {
            ctx: Ctx { hub, http: http_client(), emotes: Arc::new(Emotes::default()), config },
            tasks: Mutex::new(HashMap::new()),
        }
    }

    pub fn emotes(&self) -> Arc<Emotes> {
        self.ctx.emotes.clone()
    }

    pub fn normalize(platform: Platform, input: &str) -> String {
        match platform {
            Platform::Twitch => twitch::normalize(input),
            Platform::YouTube => youtube::normalize(input),
            Platform::Kick => kick::normalize(input),
            Platform::TikTok => tiktok::normalize(input),
        }
    }

    /// (Re)connects a platform to `channel`; an empty channel disconnects it.
    pub fn connect(&self, platform: Platform, channel: &str) {
        if let Some(old) = self.tasks.lock().unwrap().remove(&platform) {
            old.abort();
        }
        let hub = &self.ctx.hub;
        hub.set_stream(platform, channel);
        if platform == Platform::Twitch {
            self.ctx.emotes.clear(); // channel emotes belong to the old channel
        }
        if channel.is_empty() {
            hub.update_status(platform, |s| {
                s.state = ConnState::Off;
                s.channel.clear();
                s.detail.clear();
                s.is_virtual = false;
            });
            return;
        }
        hub.update_status(platform, |s| {
            s.state = ConnState::Connecting;
            s.channel = channel.to_string();
            s.detail = format!("Connecting to {}...", platform.name());
            s.is_virtual = false;
        });

        let ctx = self.ctx.clone();
        let channel = channel.to_string();
        let handle = tokio::spawn(async move {
            match platform {
                Platform::Twitch => twitch::run(ctx, channel).await,
                Platform::YouTube => youtube::run(ctx, channel).await,
                Platform::Kick => kick::run(ctx, channel).await,
                Platform::TikTok => tiktok::run(ctx, channel).await,
            }
        });
        self.tasks.lock().unwrap().insert(platform, handle);
    }
}

/// Exponential backoff: 5s, 10s, 20s ... capped at `max`.
pub fn backoff(attempt: u32, max: Duration) -> Duration {
    let secs = 5u64.saturating_mul(1 << attempt.min(6));
    Duration::from_secs(secs).min(max)
}
