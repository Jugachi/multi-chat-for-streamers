//! Kick chat. Kick has no official chat library; its web player reads chat from
//! a public Pusher websocket. We look up the channel's chatroom id once, then subscribe.

use super::Ctx;
use crate::emotes::Emotes;
use crate::html::escape;
use crate::hub::{Activity, ChatMessage, ConnState};
use crate::platform::Platform;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

const P: Platform = Platform::Kick;
const PUSHER_URL: &str = "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false";
const RETRY: Duration = Duration::from_secs(30);

/// Accepts "name", "@name" or a kick.com URL.
pub fn normalize(input: &str) -> String {
    let mut s = input.trim().to_string();
    let lower = s.to_lowercase();
    if let Some(i) = lower.find("kick.com/") {
        s = s[i + "kick.com/".len()..].split(['/', '?', '#']).next().unwrap_or("").to_string();
    }
    s.trim_start_matches('@').to_lowercase()
}

pub async fn run(ctx: Ctx, channel: String) {
    loop {
        ctx.hub.set_state(P, ConnState::Connecting, "Looking up Kick channel...");
        let chatroom_id = match fetch_chatroom_id(&ctx.http, &channel).await {
            Ok(id) => id,
            Err(e) => {
                ctx.retry_later(P, &format!("Lookup failed ({e})."), RETRY).await;
                continue;
            }
        };
        let reason = match session(&ctx, chatroom_id).await {
            Ok(()) => "Chat connection closed.".to_string(),
            Err(e) => format!("Chat connection failed ({e})."),
        };
        ctx.retry_later(P, &reason, RETRY).await;
    }
}

async fn fetch_chatroom_id(http: &reqwest::Client, slug: &str) -> anyhow::Result<u64> {
    let res = http
        .get(format!("https://kick.com/api/v2/channels/{slug}"))
        .header("Accept", "application/json")
        .send()
        .await?;
    if !res.status().is_success() {
        anyhow::bail!("Kick API returned HTTP {}", res.status().as_u16());
    }
    let data: Value = res.json().await?;
    data["chatroom"]["id"].as_u64().ok_or_else(|| anyhow::anyhow!("channel not found"))
}

async fn session(ctx: &Ctx, chatroom_id: u64) -> anyhow::Result<()> {
    let (ws, _) = tokio_tungstenite::connect_async(PUSHER_URL).await?;
    let (mut tx, mut rx) = ws.split();
    while let Some(frame) = rx.next().await {
        let text = match frame? {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => return Ok(()),
            _ => continue,
        };
        let Ok(packet) = serde_json::from_str::<Value>(&text) else { continue };
        // Pusher double-encodes event payloads as a JSON string.
        let data = match &packet["data"] {
            Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Null),
            other => other.clone(),
        };
        match packet["event"].as_str().unwrap_or("") {
            "pusher:connection_established" => {
                let sub = json!({ "event": "pusher:subscribe", "data": { "auth": "", "channel": format!("chatrooms.{chatroom_id}.v2") } });
                tx.send(Message::text(sub.to_string())).await?;
            }
            "pusher_internal:subscription_succeeded" => {
                ctx.hub.set_state(P, ConnState::Connected, "");
                ctx.hub.announce_connected(P);
            }
            "pusher:ping" => tx.send(Message::text(json!({ "event": "pusher:pong", "data": {} }).to_string())).await?,
            "pusher:error" => println!("Kick chat error: {data}"),
            event => handle_event(ctx, event, &data),
        }
    }
    Ok(())
}

pub fn handle_event(ctx: &Ctx, event: &str, data: &Value) {
    let act = |kind: &'static str, text: String| ctx.hub.activity(Activity { platform: P.name(), kind, text });
    let s = |v: &Value| match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    };
    match event {
        "App\\Events\\ChatMessageEvent" => ctx.hub.chat(ChatMessage {
            platform: P.name(),
            author: escape(&s(&data["sender"]["username"])),
            message: format_message(data["content"].as_str().unwrap_or(""), &ctx.emotes),
            color: data["sender"]["identity"]["color"].as_str().unwrap_or(P.brand_color()).to_string(),
        }),
        "App\\Events\\SubscriptionEvent" => {
            let months = data["months"].as_u64().unwrap_or(1);
            let name = s(&data["username"]);
            if months > 1 {
                act("resub", format!("{name} resubscribed for {months} months!"));
            } else {
                act("sub", format!("{name} just subscribed!"));
            }
        }
        "App\\Events\\GiftedSubscriptionsEvent" => {
            let count = data["gifted_usernames"].as_array().map(Vec::len).unwrap_or(0).max(1);
            act("gift", format!("{} gifted {count} sub{}!", s(&data["gifter_username"]), if count == 1 { "" } else { "s" }));
        }
        "App\\Events\\StreamHostEvent" => {
            act("host", format!("{} is hosting with {} viewers!", s(&data["host_username"]), s(&data["number_viewers"])));
        }
        _ => {}
    }
}

/// Kick emotes arrive inline as `[emote:12345:NAME]`.
pub fn format_message(content: &str, emotes: &Emotes) -> String {
    let mut html = String::new();
    let mut rest = content;
    while let Some(start) = rest.find("[emote:") {
        let after = &rest[start..];
        let Some(end) = after.find(']') else { break };
        let inner = &after["[emote:".len()..end];
        match inner.split_once(':') {
            Some((id, name)) if !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) => {
                html.push_str(&emotes.parse(&rest[..start]));
                html.push_str(&format!(r#"<img src="https://files.kick.com/emotes/{id}/fullsize" class="emote" alt="{}">"#, escape(name)));
            }
            _ => html.push_str(&emotes.parse(&rest[..start + end + 1])),
        }
        rest = &after[end + 1..];
    }
    html.push_str(&emotes.parse(rest));
    html
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_input() {
        assert_eq!(normalize("https://kick.com/SomeStreamer?x=1"), "somestreamer");
        assert_eq!(normalize("@Foo"), "foo");
    }

    #[test]
    fn formats_emotes() {
        let e = Emotes::default();
        assert_eq!(
            format_message("gg [emote:37226:KEKW] <3", &e),
            r#"gg <img src="https://files.kick.com/emotes/37226/fullsize" class="emote" alt="KEKW"> &lt;3"#
        );
        assert_eq!(format_message("[emote:x:bad] ok", &e), "[emote:x:bad] ok");
    }
}
