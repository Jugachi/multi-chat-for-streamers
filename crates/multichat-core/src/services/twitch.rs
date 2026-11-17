//! Twitch chat via anonymous IRC over WebSocket (read-only, no login needed).

use super::{backoff, Ctx};
use crate::emotes::Emotes;
use crate::html::escape;
use crate::hub::{Activity, ChatMessage, ConnState};
use crate::platform::Platform;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

const P: Platform = Platform::Twitch;
const IRC_URL: &str = "wss://irc-ws.chat.twitch.tv:443";

pub fn normalize(input: &str) -> String {
    let mut s = input.trim();
    if let Some(i) = s.to_ascii_lowercase().find("twitch.tv/") {
        s = &s[i + "twitch.tv/".len()..];
        s = s.split(['/', '?', '#']).next().unwrap_or("");
    }
    s.trim_start_matches('#').trim_start_matches('@').to_string()
}

pub async fn run(ctx: Ctx, channel: String) {
    let mut attempt = 0;
    loop {
        ctx.hub.set_state(P, ConnState::Connecting, "Connecting to Twitch chat...");
        let reason = match session(&ctx, &channel, &mut attempt).await {
            Ok(()) => "Disconnected.".to_string(),
            Err(e) => format!("Connection failed ({e})."),
        };
        ctx.retry_later(P, &reason, backoff(attempt, Duration::from_secs(60))).await;
        attempt += 1;
    }
}

async fn session(ctx: &Ctx, channel: &str, attempt: &mut u32) -> anyhow::Result<()> {
    let (ws, _) = tokio_tungstenite::connect_async(IRC_URL).await?;
    let (mut tx, mut rx) = ws.split();
    let nick = format!("justinfan{}", fastrand::u32(10_000..99_999));
    for line in [
        "CAP REQ :twitch.tv/tags twitch.tv/commands".to_string(),
        "PASS SCHMOOPIIE".to_string(),
        format!("NICK {nick}"),
        format!("JOIN #{}", channel.to_lowercase()),
    ] {
        tx.send(Message::text(line)).await?;
    }

    let mut joined = false;
    while let Some(frame) = rx.next().await {
        let text = match frame? {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => return Ok(()),
            _ => continue,
        };
        for raw in text.split("\r\n").filter(|l| !l.is_empty()) {
            let Some(msg) = IrcMessage::parse(raw) else { continue };
            match msg.command.as_str() {
                "PING" => tx.send(Message::text(format!("PONG :{}", msg.trailing()))).await?,
                "RECONNECT" => return Ok(()),
                // End of the JOIN reply: we're in the channel.
                "366" | "ROOMSTATE" if !joined => {
                    joined = true;
                    *attempt = 0;
                    ctx.hub.set_state(P, ConnState::Connected, "");
                    ctx.hub.announce_connected(P);
                    if let Some(room_id) = msg.tags.get("room-id") {
                        load_emotes(ctx, room_id);
                    }
                }
                "ROOMSTATE" => {
                    if let Some(room_id) = msg.tags.get("room-id") {
                        load_emotes(ctx, room_id);
                    }
                }
                "NOTICE" => {
                    let id = msg.tags.get("msg-id").map(String::as_str).unwrap_or("");
                    if id.contains("suspended") || id.contains("banned") || id == "msg_channel_suspended" {
                        anyhow::bail!("{}", msg.trailing());
                    }
                }
                "PRIVMSG" => handle_privmsg(ctx, &msg),
                "USERNOTICE" => handle_usernotice(ctx, &msg),
                _ => {}
            }
        }
    }
    Ok(())
}

fn load_emotes(ctx: &Ctx, room_id: &str) {
    if !ctx.emotes.is_empty() {
        return;
    }
    let (http, emotes, room_id) = (ctx.http.clone(), ctx.emotes.clone(), room_id.to_string());
    tokio::spawn(async move { emotes.load_for_twitch_room(&http, &room_id).await });
}

fn display_name(msg: &IrcMessage) -> String {
    msg.tags
        .get("display-name")
        .filter(|n| !n.is_empty())
        .cloned()
        .unwrap_or_else(|| msg.nick().to_string())
}

fn handle_privmsg(ctx: &Ctx, msg: &IrcMessage) {
    let name = display_name(msg);
    let text = msg.trailing();
    // ACTION (/me) messages arrive wrapped in \x01ACTION ...\x01
    let text = text.strip_prefix("\u{1}ACTION ").map(|t| t.trim_end_matches('\u{1}')).unwrap_or(text);
    ctx.hub.chat(ChatMessage {
        platform: P.name(),
        author: escape(&name),
        message: format_message(text, msg.tags.get("emotes").map(String::as_str), &ctx.emotes),
        color: msg.tags.get("color").filter(|c| !c.is_empty()).cloned().unwrap_or_else(|| P.brand_color().into()),
    });
    if let Some(bits) = msg.tags.get("bits") {
        activity(ctx, "bits", format!("{name} cheered {bits} bits!"));
    }
}

fn handle_usernotice(ctx: &Ctx, msg: &IrcMessage) {
    let name = display_name(msg);
    let tag = |k: &str| msg.tags.get(k).cloned().unwrap_or_default();
    match tag("msg-id").as_str() {
        "sub" => activity(ctx, "sub", format!("{name} just subscribed!")),
        "resub" => activity(ctx, "resub", format!("{name} resubscribed for {} months!", tag("msg-param-cumulative-months"))),
        "subgift" => activity(ctx, "gift", format!("{name} gifted a sub to {}!", tag("msg-param-recipient-display-name"))),
        "submysterygift" => activity(ctx, "gift", format!("{name} gifted {} subs!", tag("msg-param-mass-gift-count"))),
        "raid" => activity(ctx, "raid", format!("{} is raiding with {} viewers!", tag("msg-param-displayName"), tag("msg-param-viewerCount"))),
        _ => {}
    }
}

fn activity(ctx: &Ctx, kind: &'static str, text: String) {
    ctx.hub.activity(Activity { platform: P.name(), kind, text });
}

/// Builds safe HTML: native Twitch emotes (from the `emotes` tag, positions in
/// characters) become images, the rest goes through the 7TV/BTTV/FFZ parser.
pub fn format_message(text: &str, emotes_tag: Option<&str>, third_party: &Emotes) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut ranges: Vec<(usize, usize, String)> = Vec::new();
    for entry in emotes_tag.unwrap_or("").split('/').filter(|e| !e.is_empty()) {
        let Some((id, positions)) = entry.split_once(':') else { continue };
        for pos in positions.split(',') {
            if let Some((a, b)) = pos.split_once('-') {
                if let (Ok(a), Ok(b)) = (a.parse::<usize>(), b.parse::<usize>()) {
                    if a <= b && b < chars.len() {
                        ranges.push((a, b, id.to_string()));
                    }
                }
            }
        }
    }
    ranges.sort_by_key(|r| r.0);

    let mut html = String::new();
    let mut i = 0;
    for (start, end, id) in ranges {
        if start < i {
            continue; // overlapping/garbled tag
        }
        html.push_str(&third_party.parse(&chars[i..start].iter().collect::<String>()));
        let id: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
        html.push_str(&format!(r#"<img src="https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/1.0" class="emote">"#));
        i = end + 1;
    }
    html.push_str(&third_party.parse(&chars[i.min(chars.len())..].iter().collect::<String>()));
    html
}

/// A parsed IRC line: `@tags :prefix COMMAND params :trailing`
#[derive(Debug, Default)]
pub struct IrcMessage {
    pub tags: HashMap<String, String>,
    pub prefix: String,
    pub command: String,
    pub params: Vec<String>,
}

impl IrcMessage {
    pub fn parse(line: &str) -> Option<IrcMessage> {
        let mut rest = line;
        let mut msg = IrcMessage::default();
        if let Some(r) = rest.strip_prefix('@') {
            let (tags, r) = r.split_once(' ')?;
            for tag in tags.split(';') {
                let (k, v) = tag.split_once('=').unwrap_or((tag, ""));
                msg.tags.insert(k.to_string(), unescape_tag(v));
            }
            rest = r;
        }
        if let Some(r) = rest.strip_prefix(':') {
            let (prefix, r) = r.split_once(' ').unwrap_or((r, ""));
            msg.prefix = prefix.to_string();
            rest = r;
        }
        let (head, trailing) = match rest.split_once(" :") {
            Some((h, t)) => (h, Some(t)),
            None => (rest, None),
        };
        let mut parts = head.split(' ').filter(|p| !p.is_empty());
        msg.command = parts.next()?.to_string();
        msg.params = parts.map(str::to_string).collect();
        if let Some(t) = trailing {
            msg.params.push(t.to_string());
        } else if let Some(t) = rest.strip_prefix(':') {
            msg.params.push(t.to_string());
        }
        Some(msg)
    }

    pub fn trailing(&self) -> &str {
        self.params.last().map(String::as_str).unwrap_or("")
    }

    /// `nick!user@host` -> `nick`
    pub fn nick(&self) -> &str {
        self.prefix.split('!').next().unwrap_or("")
    }
}

fn unescape_tag(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut chars = v.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some(':') => out.push(';'),
            Some('s') => out.push(' '),
            Some('\\') => out.push('\\'),
            Some('r') => out.push('\r'),
            Some('n') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_privmsg_with_tags() {
        let m = IrcMessage::parse(
            "@badge-info=;color=#FF4500;display-name=Pixel\\sPanda;emotes=25:0-4 :pixel!pixel@pixel.tmi.twitch.tv PRIVMSG #jugachi :Kappa hello :)",
        )
        .unwrap();
        assert_eq!(m.command, "PRIVMSG");
        assert_eq!(m.tags["display-name"], "Pixel Panda");
        assert_eq!(m.tags["color"], "#FF4500");
        assert_eq!(m.params, vec!["#jugachi", "Kappa hello :)"]);
        assert_eq!(m.nick(), "pixel");
    }

    #[test]
    fn parses_ping() {
        let m = IrcMessage::parse("PING :tmi.twitch.tv").unwrap();
        assert_eq!(m.command, "PING");
        assert_eq!(m.trailing(), "tmi.twitch.tv");
    }

    #[test]
    fn formats_native_emotes_and_escapes() {
        let emotes = Emotes::default();
        let html = format_message("🔥 Kappa <b>", Some("25:2-6"), &emotes);
        assert_eq!(
            html,
            r#"🔥 <img src="https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0" class="emote"> &lt;b&gt;"#
        );
    }

    #[test]
    fn ignores_out_of_range_emote_positions() {
        let emotes = Emotes::default();
        assert_eq!(format_message("hi", Some("25:0-10"), &emotes), "hi");
    }

    #[test]
    fn normalizes_channel_input() {
        assert_eq!(normalize(" https://www.twitch.tv/Jugachi?x=1 "), "Jugachi");
        assert_eq!(normalize("#jugachi"), "jugachi");
    }
}
