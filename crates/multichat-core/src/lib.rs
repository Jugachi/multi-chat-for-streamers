//! Multi-Chat core: everything except the desktop window.
//!
//! - [`server`]   HTTP + WebSocket server (chat page, OBS overlay, theme editor, theme API)
//! - [`hub`]      shared state: chat/activity history, connection status, active channels
//! - [`services`] one module per platform (Twitch, YouTube, Kick, TikTok)
//! - [`virtual_mode`] simulated chat for testing without any network access
//! - [`themes`]   built-in + custom themes, hot reload
//! - [`config`]   config.json and data folder handling
//!
//! The web front end lives in `public/` and is compiled into the binary.

pub mod assets;
pub mod config;
pub mod emotes;
pub mod html;
pub mod hub;
pub mod platform;
pub mod server;
pub mod services;
pub mod themes;
pub mod virtual_mode;

pub use config::Options;
pub use server::{start, RunningServer};
