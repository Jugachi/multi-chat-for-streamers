//! YouTube live chat without an API key: read the live page once for the
//! innertube key/version/continuation, then poll `get_live_chat` every second
//! (the same approach as the `youtube-chat` npm package).

use super::Ctx;
use crate::emotes::Emotes;
use crate::html::escape;
use crate::hub::{Activity, ChatMessage, ConnState};
use crate::platform::Platform;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;

const P: Platform = Platform::YouTube;
const RETRY: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(1000);
// EU visitors otherwise get redirected to the cookie consent page.
const CONSENT_COOKIE: &str = "SOCS=CAI; CONSENT=YES+1";

fn is_channel_id(s: &str) -> bool {
    s.starts_with("UC") && s.len() == 24
}

/// Accepts a channel ID (UC...), a video ID, or a watch / youtu.be / live URL.
pub fn normalize(input: &str) -> String {
    let s = input.trim();
    if s.is_empty() || is_channel_id(s) {
        return s.to_string();
    }
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?:v=|youtu\.be/|/live/)([A-Za-z0-9_-]+)").unwrap());
    re.captures(s).map(|c| c[1].to_string()).unwrap_or_else(|| s.to_string())
}

#[derive(Debug, PartialEq)]
pub struct LiveOptions {
    pub live_id: String,
    pub api_key: String,
    pub client_version: String,
    pub continuation: String,
}

pub async fn run(ctx: Ctx, channel: String) {
    loop {
        ctx.hub.set_state(P, ConnState::Connecting, "Connecting to YouTube live chat...");
        let mut options = match fetch_live_page(&ctx.http, &channel).await {
            Ok(o) => o,
            Err(e) => {
                println!("YouTube: {e}");
                ctx.retry_later(P, "Not live (or unreachable).", RETRY).await;
                continue;
            }
        };
        ctx.hub.set_state(P, ConnState::Connected, "");
        ctx.hub.announce_connected(P);

        let reason = loop {
            tokio::time::sleep(POLL).await;
            match fetch_chat(&ctx.http, &options).await {
                Ok((actions, next)) => {
                    for action in &actions {
                        handle_action(&ctx, action);
                    }
                    match next {
                        Some(c) => options.continuation = c,
                        None => break "Live chat ended.",
                    }
                }
                Err(e) => {
                    println!("YouTube chat error: {e}");
                    break "Chat dropped.";
                }
            }
        };
        ctx.retry_later(P, reason, RETRY).await;
    }
}

async fn fetch_live_page(http: &reqwest::Client, id: &str) -> anyhow::Result<LiveOptions> {
    let url = if is_channel_id(id) {
        format!("https://www.youtube.com/channel/{id}/live")
    } else {
        format!("https://www.youtube.com/watch?v={id}")
    };
    let html = http
        .get(url)
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Cookie", CONSENT_COOKIE)
        .send()
        .await?
        .text()
        .await?;
    parse_live_page(&html)
}

pub fn parse_live_page(html: &str) -> anyhow::Result<LiveOptions> {
    let find = |pattern: &str, what: &str| -> anyhow::Result<String> {
        Regex::new(pattern)
            .unwrap()
            .captures(html)
            .map(|c| c[1].to_string())
            .ok_or_else(|| anyhow::anyhow!("{what} was not found"))
    };
    let live_id = find(r#"<link rel="canonical" href="https://www\.youtube\.com/watch\?v=(.+?)">"#, "Live stream")?;
    if Regex::new(r#"['"]isReplay['"]:\s*true"#).unwrap().is_match(html) {
        anyhow::bail!("{live_id} is a finished stream");
    }
    Ok(LiveOptions {
        api_key: find(r#"['"]INNERTUBE_API_KEY['"]:\s*['"](.+?)['"]"#, "API key")?,
        client_version: find(r#"['"]clientVersion['"]:\s*['"]([\d.]+?)['"]"#, "Client version")?,
        continuation: find(r#"['"]continuation['"]:\s*['"](.+?)['"]"#, "Continuation")?,
        live_id,
    })
}

async fn fetch_chat(http: &reqwest::Client, o: &LiveOptions) -> anyhow::Result<(Vec<Value>, Option<String>)> {
    let body = json!({
        "context": { "client": { "clientVersion": o.client_version, "clientName": "WEB" } },
        "continuation": o.continuation,
    });
    let data: Value = http
        .post(format!("https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key={}", o.api_key))
        .header("Cookie", CONSENT_COOKIE)
        .json(&body)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(parse_chat_response(&data))
}

/// Returns the chat actions and the next continuation (None = chat is over).
pub fn parse_chat_response(data: &Value) -> (Vec<Value>, Option<String>) {
    let cont = &data["continuationContents"]["liveChatContinuation"];
    let actions = cont["actions"].as_array().cloned().unwrap_or_default();
    let next = cont["continuations"][0]
        .as_object()
        .and_then(|c| {
            ["invalidationContinuationData", "timedContinuationData", "reloadContinuationData"]
                .iter()
                .find_map(|k| c.get(*k))
        })
        .and_then(|c| c["continuation"].as_str())
        .map(str::to_string);
    (actions, next)
}

fn handle_action(ctx: &Ctx, action: &Value) {
    let item = &action["addChatItemAction"]["item"];
    if let Some(r) = item.get("liveChatTextMessageRenderer") {
        chat(ctx, r, &r["message"]);
    } else if let Some(r) = item.get("liveChatPaidMessageRenderer") {
        chat(ctx, r, &r["message"]);
        let amount = r["purchaseAmountText"]["simpleText"].as_str().unwrap_or("");
        activity(ctx, "superchat", format!("{} sent a Super Chat ({amount})!", author(r)));
    } else if let Some(r) = item.get("liveChatPaidStickerRenderer") {
        let amount = r["purchaseAmountText"]["simpleText"].as_str().unwrap_or("");
        activity(ctx, "superchat", format!("{} sent a Super Sticker ({amount})!", author(r)));
    } else if let Some(r) = item.get("liveChatMembershipItemRenderer") {
        activity(ctx, "member", format!("{} became a member!", author(r)));
    }
}

fn author(renderer: &Value) -> String {
    renderer["authorName"]["simpleText"].as_str().unwrap_or("Someone").to_string()
}

fn chat(ctx: &Ctx, renderer: &Value, message: &Value) {
    let html = runs_to_html(message, &ctx.emotes);
    if html.is_empty() {
        return;
    }
    ctx.hub.chat(ChatMessage { platform: P.name(), author: escape(&author(renderer)), message: html, color: P.brand_color().into() });
}

fn activity(ctx: &Ctx, kind: &'static str, text: String) {
    ctx.hub.activity(Activity { platform: P.name(), kind, text });
}

/// Message runs: `{ text }` or `{ emoji: { image: { thumbnails: [{url}] }, shortcuts: [..] } }`.
pub fn runs_to_html(message: &Value, emotes: &Emotes) -> String {
    let mut html = String::new();
    for run in message["runs"].as_array().into_iter().flatten() {
        if let Some(text) = run["text"].as_str() {
            html.push_str(&emotes.parse(text));
        } else if let Some(url) = run["emoji"]["image"]["thumbnails"][0]["url"].as_str() {
            let alt = run["emoji"]["shortcuts"][0].as_str().unwrap_or("");
            html.push_str(&format!(r#"<img src="{}" class="emote" alt="{}">"#, escape(url), escape(alt)));
        }
    }
    html.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_ids_and_urls() {
        assert_eq!(normalize("https://www.youtube.com/watch?v=abc123&t=1"), "abc123");
        assert_eq!(normalize("https://youtu.be/xyz_9"), "xyz_9");
        assert_eq!(normalize("https://www.youtube.com/live/Live1-2?si=x"), "Live1-2");
        assert_eq!(normalize("UCVQFwBj0jJ4w4mdYwd1nibw"), "UCVQFwBj0jJ4w4mdYwd1nibw");
    }

    #[test]
    fn parses_live_page() {
        let html = r#"<link rel="canonical" href="https://www.youtube.com/watch?v=VID123"> "INNERTUBE_API_KEY":"KEY1","clientVersion":"2.20240101.00.00","continuation":"CONT1""#;
        let o = parse_live_page(html).unwrap();
        assert_eq!(o, LiveOptions { live_id: "VID123".into(), api_key: "KEY1".into(), client_version: "2.20240101.00.00".into(), continuation: "CONT1".into() });
        assert!(parse_live_page("<html></html>").is_err());
    }

    #[test]
    fn parses_chat_response_and_runs() {
        let data = json!({ "continuationContents": { "liveChatContinuation": {
            "actions": [{ "addChatItemAction": { "item": { "liveChatTextMessageRenderer": {
                "authorName": { "simpleText": "Moon <Mage>" },
                "message": { "runs": [ { "text": "hi <3 " }, { "emoji": { "image": { "thumbnails": [{ "url": "https://yt/e.png" }] }, "shortcuts": [":wave:"] } } ] }
            }}}}],
            "continuations": [{ "timedContinuationData": { "continuation": "NEXT" } }]
        }}});
        let (actions, next) = parse_chat_response(&data);
        assert_eq!(next.as_deref(), Some("NEXT"));
        let r = &actions[0]["addChatItemAction"]["item"]["liveChatTextMessageRenderer"];
        assert_eq!(author(r), "Moon <Mage>");
        assert_eq!(
            runs_to_html(&r["message"], &Emotes::default()),
            r#"hi &lt;3 <img src="https://yt/e.png" class="emote" alt=":wave:">"#
        );
    }
}
