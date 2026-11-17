//! TikTok LIVE chat, ported from the `tiktok-live-connector` npm package (v2.5).
//!
//! Flow:
//! 1. Resolve the room id from the username (live page JSON, then the api-live endpoint).
//! 2. Ask the Euler Stream sign server (third-party service) for a signed websocket
//!    URL + the first batch of messages. Optional API key: `tiktokSignApiKey` in config.json.
//! 3. Connect to TikTok's push websocket, send "enter room" + heartbeats every 10s,
//!    ACK message batches, decode protobuf chat/gift/follow messages.
//!
//! Only the protobuf fields we use are declared; prost skips unknown fields.

use super::Ctx;
use crate::emotes::Emotes;
use crate::html::escape;
use crate::hub::{Activity, ChatMessage, ConnState};
use crate::platform::Platform;
use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::time::Duration;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const P: Platform = Platform::TikTok;
const RETRY: Duration = Duration::from_secs(60);
const HEARTBEAT: Duration = Duration::from_secs(10);
const SIGN_SERVER: &str = "https://api.eulerstream.com";
// Browser profile TikTok's web client expects (same values as the npm package).
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/128.0.2739.79";

// ---------- protobuf (field numbers from tiktok-live-proto v3) ----------

#[derive(Clone, PartialEq, prost::Message)]
pub struct PushFrame {
    #[prost(int64, tag = "1")]
    pub seq_id: i64,
    #[prost(int64, tag = "2")]
    pub log_id: i64,
    #[prost(string, tag = "6")]
    pub payload_encoding: String,
    #[prost(string, tag = "7")]
    pub payload_type: String,
    #[prost(bytes = "vec", tag = "8")]
    pub payload: Vec<u8>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct FetchResult {
    #[prost(message, repeated, tag = "1")]
    pub messages: Vec<BaseMessage>,
    #[prost(string, tag = "2")]
    pub cursor: String,
    #[prost(string, tag = "5")]
    pub internal_ext: String,
    #[prost(map = "string, string", tag = "7")]
    pub route_params: HashMap<String, String>,
    #[prost(bool, tag = "9")]
    pub need_ack: bool,
    #[prost(string, tag = "10")]
    pub push_server: String,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct BaseMessage {
    #[prost(string, tag = "1")]
    pub method: String,
    #[prost(bytes = "vec", tag = "2")]
    pub payload: Vec<u8>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct Text {
    #[prost(string, tag = "1")]
    pub key: String,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct Common {
    #[prost(message, optional, tag = "8")]
    pub display_text: Option<Text>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct User {
    #[prost(int64, tag = "1")]
    pub id: i64,
    #[prost(string, tag = "3")]
    pub nickname: String,
    #[prost(string, tag = "38")]
    pub display_id: String,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct ChatMsg {
    #[prost(message, optional, tag = "2")]
    pub user: Option<User>,
    #[prost(string, tag = "3")]
    pub content: String,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct Gift {
    #[prost(int32, tag = "11")]
    pub gift_type: i32,
    #[prost(string, tag = "16")]
    pub name: String,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct GiftMsg {
    #[prost(int32, tag = "5")]
    pub repeat_count: i32,
    #[prost(message, optional, tag = "7")]
    pub user: Option<User>,
    #[prost(int32, tag = "9")]
    pub repeat_end: i32,
    #[prost(message, optional, tag = "15")]
    pub gift: Option<Gift>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct SocialMsg {
    #[prost(message, optional, tag = "1")]
    pub common: Option<Common>,
    #[prost(message, optional, tag = "2")]
    pub user: Option<User>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct ControlMsg {
    #[prost(int32, tag = "2")]
    pub action: i32,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct HeartBeat {
    #[prost(int64, tag = "1")]
    pub room_id: i64,
    #[prost(int64, tag = "2")]
    pub send_packet_seq_id: i64,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct EnterRoom {
    #[prost(int64, tag = "1")]
    pub room_id: i64,
    #[prost(int64, tag = "4")]
    pub live_id: i64,
    #[prost(string, tag = "5")]
    pub identity: String,
    #[prost(int64, tag = "8")]
    pub enter_unique_id: i64,
    #[prost(string, tag = "9")]
    pub filter_welcome_msg: String,
}

// ---------- connection ----------

/// Accepts "name", "@name" or a tiktok.com URL.
pub fn normalize(input: &str) -> String {
    let mut s = input.trim().to_string();
    if let Some(i) = s.to_lowercase().find("tiktok.com/") {
        s = s[i + "tiktok.com/".len()..].split(['/', '?', '#']).next().unwrap_or("").to_string();
    }
    s.trim_start_matches('@').to_string()
}

enum Outcome {
    Offline,
    Ended,
    Closed,
}

pub async fn run(ctx: Ctx, username: String) {
    loop {
        ctx.hub.set_state(P, ConnState::Connecting, "Connecting to TikTok LIVE...");
        let reason = match session(&ctx, &username).await {
            Ok(Outcome::Offline) => "Not live.".to_string(),
            Ok(Outcome::Ended) => "Stream ended.".to_string(),
            Ok(Outcome::Closed) => "Disconnected.".to_string(),
            Err(e) => {
                println!("TikTok connect failed for \"{username}\": {e}");
                format!("Connection failed ({e}).")
            }
        };
        ctx.retry_later(P, &reason, RETRY).await;
    }
}

/// Cookies we have to forward to the websocket (TikTok + the sign server's).
#[derive(Default)]
struct CookieJar(Vec<(String, String)>);

impl CookieJar {
    fn absorb(&mut self, headers: &reqwest::header::HeaderMap) {
        for value in headers.get_all(reqwest::header::SET_COOKIE) {
            if let Ok(v) = value.to_str() {
                self.add(v);
            }
        }
    }

    /// Takes the first `name=value` of a cookie string.
    fn add(&mut self, cookie: &str) {
        if let Some((name, value)) = cookie.split(';').next().and_then(|c| c.split_once('=')) {
            let name = name.trim().to_string();
            self.0.retain(|(n, _)| *n != name);
            self.0.push((name, value.trim().to_string()));
        }
    }

    fn header(&self) -> String {
        self.0.iter().map(|(n, v)| format!("{n}={v}")).collect::<Vec<_>>().join("; ")
    }
}

fn device_id() -> String {
    (0..19).map(|i| char::from(b'0' + if i == 0 { fastrand::u8(1..10) } else { fastrand::u8(0..10) })).collect()
}

fn http_params(device_id: &str) -> Vec<(&'static str, String)> {
    let (browser_name, browser_version) = UA.split_once('/').unwrap_or((UA, ""));
    [
        ("aid", "1988"), ("app_language", "en"), ("app_name", "tiktok_web"), ("browser_language", "en-DE"),
        ("browser_name", browser_name), ("browser_online", "true"), ("browser_platform", "MacIntel"),
        ("browser_version", browser_version), ("cookie_enabled", "true"), ("device_platform", "web_pc"),
        ("focus_state", "true"), ("from_page", "user"), ("history_len", "10"), ("is_fullscreen", "false"),
        ("is_page_visible", "true"), ("screen_height", "1080"), ("screen_width", "1920"), ("tz_name", "Europe/Berlin"),
        ("referer", "https://www.tiktok.com/"), ("root_referer", "https://www.tiktok.com/"), ("channel", "tiktok_web"),
        ("data_collection_enabled", "true"), ("os", "mac"), ("priority_region", "DE"), ("region", "DE"),
        ("user_is_login", "true"), ("webcast_language", "en"), ("device_id", device_id),
    ]
    .into_iter()
    .map(|(k, v)| (k, v.to_string()))
    .collect()
}

fn tiktok_get(ctx: &Ctx, url: &str, params: &[(&str, String)], jar: &CookieJar) -> reqwest::RequestBuilder {
    let mut cookie = jar.header();
    if !cookie.is_empty() {
        cookie.push_str("; ");
    }
    cookie.push_str("tt-target-idc=useast1a");
    ctx.http
        .get(url)
        .query(params)
        .header("User-Agent", UA)
        .header("Accept", "text/html,application/json,application/protobuf")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Referer", "https://www.tiktok.com/")
        .header("Origin", "https://www.tiktok.com")
        .header("Cookie", cookie)
        .timeout(Duration::from_secs(10))
}

/// Returns (room id, live status) — status 4 means offline.
async fn resolve_room(ctx: &Ctx, user: &str, params: &[(&'static str, String)], jar: &mut CookieJar) -> anyhow::Result<(String, Option<i64>)> {
    // 1. Live page: <script id="SIGI_STATE" type="application/json">...</script>
    if let Ok(res) = tiktok_get(ctx, &format!("https://www.tiktok.com/@{user}/live"), params, jar).send().await {
        jar.absorb(res.headers());
        if let Ok(html) = res.text().await {
            let re = Regex::new(r#"(?s)<script id="SIGI_STATE" type="application/json">(.*?)</script>"#).unwrap();
            if let Some(json) = re.captures(&html).and_then(|c| serde_json::from_str::<Value>(&c[1]).ok()) {
                let info = &json["LiveRoom"]["liveRoomUserInfo"];
                if let Some(id) = value_to_string(&info["user"]["roomId"]).filter(|id| !id.is_empty()) {
                    return Ok((id, info["liveRoom"]["status"].as_i64()));
                }
            }
        }
    }
    // 2. api-live JSON
    let mut api_params = params.to_vec();
    api_params.push(("uniqueId", user.to_string()));
    api_params.push(("sourceType", "54".into()));
    let res = tiktok_get(ctx, "https://www.tiktok.com/api-live/user/room/", &api_params, jar).send().await?;
    jar.absorb(res.headers());
    let json: Value = res.json().await?;
    if json["statusCode"].as_i64().unwrap_or(0) != 0 {
        anyhow::bail!("user not found or not live (statusCode {})", json["statusCode"]);
    }
    let id = value_to_string(&json["data"]["user"]["roomId"]).filter(|id| !id.is_empty()).ok_or_else(|| anyhow::anyhow!("no room id"))?;
    Ok((id, json["data"]["liveRoom"]["status"].as_i64()))
}

fn value_to_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

async fn session(ctx: &Ctx, username: &str) -> anyhow::Result<Outcome> {
    let device = device_id();
    let params = http_params(&device);
    let mut jar = CookieJar::default();

    let (mut room_id, status) = resolve_room(ctx, username, &params, &mut jar).await?;
    if status == Some(4) {
        return Ok(Outcome::Offline);
    }

    // Sign server: signed websocket parameters + the first message batch.
    let sign_key = ctx.config.load().get("tiktokSignApiKey").and_then(Value::as_str).filter(|k| !k.is_empty()).map(str::to_string);
    let mut req = ctx
        .http
        .get(format!("{SIGN_SERVER}/webcast/rooms/{room_id}/connect"))
        .query(&[("client", "multi-chat"), ("cursor", ""), ("user_agent", UA), ("client_enter", "true"), ("platform", "web")])
        .header("Accept", "application/protobuf,application/json")
        .header("User-Agent", concat!("multi-chat/", env!("CARGO_PKG_VERSION")));
    if let Some(key) = &sign_key {
        req = req.query(&[("apiKey", key)]).header("x-api-key", key);
    }
    let res = req.send().await?;
    match res.status().as_u16() {
        200 => {}
        429 => anyhow::bail!("sign server rate limit reached (add a tiktokSignApiKey to config.json)"),
        402 => anyhow::bail!("sign server requires a paid plan for this request"),
        code => anyhow::bail!("sign server returned HTTP {code}"),
    }
    let headers = res.headers().clone();
    if let Some(cookie) = headers.get("x-set-tt-cookie").and_then(|v| v.to_str().ok()) {
        jar.add(cookie);
    } else {
        let why = headers.get("handshake-msg").and_then(|v| v.to_str().ok()).unwrap_or("no cookie returned");
        anyhow::bail!("sign server refused: {why}");
    }
    if let Some(id) = headers.get("x-room-id").and_then(|v| v.to_str().ok()) {
        room_id = id.to_string();
    }
    let fetch = FetchResult::decode(res.bytes().await?.as_ref())?;
    if fetch.cursor.is_empty() || fetch.push_server.is_empty() {
        anyhow::bail!("sign server returned no websocket details");
    }
    let room_num: i64 = room_id.parse().unwrap_or_default();

    // Websocket URL
    let (browser_name, browser_version) = UA.split_once('/').unwrap_or((UA, ""));
    let mut ws_params: Vec<(String, String)> = [
        ("version_code", "180800"), ("aid", "1988"), ("app_language", "en"), ("app_name", "tiktok_web"),
        ("browser_platform", "MacIntel"), ("browser_language", "en-DE"), ("browser_name", browser_name),
        ("browser_version", browser_version), ("browser_online", "true"), ("cookie_enabled", "true"),
        ("tz_name", "Europe/Berlin"), ("device_platform", "web"), ("identity", "audience"), ("live_id", "12"),
        ("webcast_language", "en"), ("ws_direct", "0"), ("sup_ws_ds_opt", "1"), ("update_version_code", "2.0.0"),
        ("did_rule", "3"), ("screen_height", "1080"), ("screen_width", "1920"), ("heartbeat_duration", "0"),
        ("resp_content_type", "protobuf"), ("history_comment_count", "6"), ("client_enter", "1"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    ws_params.push(("last_rtt".into(), format!("{:.3}", 100.0 + fastrand::f64() * 100.0)));
    ws_params.push(("User-Agent".into(), UA.into()));
    ws_params.push(("compress".into(), "gzip".into()));
    ws_params.push(("room_id".into(), room_id.clone()));
    ws_params.push(("internal_ext".into(), fetch.internal_ext.clone()));
    ws_params.push(("cursor".into(), fetch.cursor.clone()));
    for (k, v) in &fetch.route_params {
        if !v.is_empty() {
            ws_params.retain(|(n, _)| n != k);
            ws_params.push((k.clone(), v.clone()));
        }
    }
    let mut url = reqwest::Url::parse(&fetch.push_server)?;
    url.query_pairs_mut().extend_pairs(&ws_params).append_pair("version_code", "270000");

    let mut request = url.as_str().into_client_request()?;
    request.headers_mut().insert("User-Agent", UA.parse()?);
    let cookie = jar.0.iter().filter(|(n, _)| !n.starts_with("sid") && !n.starts_with("sessionid") && n != "tt-target-idc");
    let cookie = cookie.map(|(n, v)| format!("{n}={v}")).collect::<Vec<_>>().join("; ");
    if !cookie.is_empty() {
        request.headers_mut().insert("Cookie", cookie.parse()?);
    }

    let (ws, _) = tokio::time::timeout(Duration::from_secs(20), tokio_tungstenite::connect_async(request)).await??;
    let (mut tx, mut rx) = ws.split();

    let enter = EnterRoom {
        room_id: room_num,
        live_id: 12,
        identity: "audience".into(),
        enter_unique_id: fastrand::i64(1..i64::MAX),
        filter_welcome_msg: "0".into(),
    };
    tx.send(Message::binary(frame("im_enter_room", enter.encode_to_vec(), 0))).await?;
    ctx.hub.set_state(P, ConnState::Connected, "");
    ctx.hub.announce_connected(P);

    // Recent messages that came with the sign response
    if dispatch(ctx, &fetch.messages) {
        return Ok(Outcome::Ended);
    }

    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    heartbeat.tick().await;
    let mut seq = 1i64;
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                let hb = HeartBeat { room_id: room_num, send_packet_seq_id: seq };
                seq += 1;
                tx.send(Message::binary(frame("hb", hb.encode_to_vec(), 0))).await?;
            }
            msg = rx.next() => {
                let data = match msg {
                    Some(Ok(Message::Binary(b))) => b,
                    Some(Ok(Message::Ping(p))) => { tx.send(Message::Pong(p)).await?; continue; }
                    Some(Ok(Message::Close(_))) | None => return Ok(Outcome::Closed),
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => return Err(e.into()),
                };
                let push = PushFrame::decode(data.as_ref())?;
                if push.payload_type != "msg" || push.payload_encoding != "pb" || push.payload.is_empty() {
                    continue;
                }
                let result = FetchResult::decode(gunzip_if_needed(&push.payload)?.as_slice())?;
                if result.need_ack && !result.internal_ext.is_empty() {
                    tx.send(Message::binary(frame("ack", result.internal_ext.clone().into_bytes(), push.log_id))).await?;
                }
                if dispatch(ctx, &result.messages) {
                    return Ok(Outcome::Ended);
                }
            }
        }
    }
}

fn frame(payload_type: &str, payload: Vec<u8>, log_id: i64) -> Vec<u8> {
    PushFrame { seq_id: 0, log_id, payload_encoding: "pb".into(), payload_type: payload_type.into(), payload }.encode_to_vec()
}

fn gunzip_if_needed(payload: &[u8]) -> std::io::Result<Vec<u8>> {
    if payload.starts_with(&[0x1f, 0x8b, 0x08]) {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(payload).read_to_end(&mut out)?;
        Ok(out)
    } else {
        Ok(payload.to_vec())
    }
}

fn display_name(user: &Option<User>) -> String {
    user.as_ref()
        .map(|u| if u.nickname.is_empty() { u.display_id.clone() } else { u.nickname.clone() })
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Someone".into())
}

/// Emits chat/activity for a batch. Returns true if the stream ended.
fn dispatch(ctx: &Ctx, messages: &[BaseMessage]) -> bool {
    for m in messages {
        match handle(&ctx.emotes, m) {
            Some(Event::Chat(c)) => ctx.hub.chat(c),
            Some(Event::Activity(a)) => ctx.hub.activity(a),
            Some(Event::Ended) => return true,
            None => {}
        }
    }
    false
}

pub enum Event {
    Chat(ChatMessage),
    Activity(Activity),
    Ended,
}

pub fn handle(emotes: &Emotes, m: &BaseMessage) -> Option<Event> {
    let act = |kind: &'static str, text: String| Some(Event::Activity(Activity { platform: P.name(), kind, text }));
    match m.method.as_str() {
        "WebcastChatMessage" => {
            let c = ChatMsg::decode(m.payload.as_slice()).ok()?;
            Some(Event::Chat(ChatMessage {
                platform: P.name(),
                author: escape(&display_name(&c.user)),
                message: emotes.parse(&c.content),
                color: P.brand_color().into(),
            }))
        }
        "WebcastGiftMessage" => {
            let g = GiftMsg::decode(m.payload.as_slice()).ok()?;
            let gift = g.gift.unwrap_or_default();
            // Streakable gifts fire repeatedly while the streak runs; only report the final count.
            if gift.gift_type == 1 && g.repeat_end == 0 {
                return None;
            }
            let count = if g.repeat_count > 1 { format!("{}x ", g.repeat_count) } else { String::new() };
            let name = if gift.name.is_empty() { "a gift".to_string() } else { gift.name };
            act("gift", format!("{} sent {count}{name}!", display_name(&g.user)))
        }
        "WebcastSocialMessage" => {
            let s = SocialMsg::decode(m.payload.as_slice()).ok()?;
            let key = s.common.and_then(|c| c.display_text).map(|t| t.key).unwrap_or_default();
            if key.contains("follow") {
                act("follow", format!("{} followed!", display_name(&s.user)))
            } else {
                None
            }
        }
        "WebcastControlMessage" => {
            let c = ControlMsg::decode(m.payload.as_slice()).ok()?;
            (c.action == 3 || c.action == 4).then_some(Event::Ended)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(nick: &str) -> Option<User> {
        Some(User { id: 1, nickname: nick.into(), display_id: "handle".into() })
    }

    #[test]
    fn normalizes_input() {
        assert_eq!(normalize("https://www.tiktok.com/@cool.user/live"), "cool.user");
        assert_eq!(normalize("@cool.user"), "cool.user");
    }

    #[test]
    fn decodes_chat_and_escapes() {
        let payload = ChatMsg { user: user("Queso <Q>"), content: "hi <3".into() }.encode_to_vec();
        let m = BaseMessage { method: "WebcastChatMessage".into(), payload };
        match handle(&Emotes::default(), &m) {
            Some(Event::Chat(c)) => {
                assert_eq!(c.author, "Queso &lt;Q&gt;");
                assert_eq!(c.message, "hi &lt;3");
            }
            _ => panic!("expected chat"),
        }
    }

    #[test]
    fn gift_streaks_report_only_the_final_count() {
        let gift = |repeat_end| GiftMsg {
            repeat_count: 5,
            user: user("Rose Fan"),
            repeat_end,
            gift: Some(Gift { gift_type: 1, name: "Rose".into() }),
        };
        let msg = |g: GiftMsg| BaseMessage { method: "WebcastGiftMessage".into(), payload: g.encode_to_vec() };
        assert!(handle(&Emotes::default(), &msg(gift(0))).is_none());
        match handle(&Emotes::default(), &msg(gift(1))) {
            Some(Event::Activity(a)) => assert_eq!(a.text, "Rose Fan sent 5x Rose!"),
            _ => panic!("expected activity"),
        }
    }

    #[test]
    fn follow_vs_share_and_stream_end() {
        let social = |key: &str| BaseMessage {
            method: "WebcastSocialMessage".into(),
            payload: SocialMsg { common: Some(Common { display_text: Some(Text { key: key.into() }) }), user: user("Otter") }.encode_to_vec(),
        };
        assert!(matches!(handle(&Emotes::default(), &social("pm_mt_guidance_viewer_follow")), Some(Event::Activity(_))));
        assert!(handle(&Emotes::default(), &social("pm_mt_guidance_share")).is_none());
        let end = BaseMessage { method: "WebcastControlMessage".into(), payload: ControlMsg { action: 3 }.encode_to_vec() };
        assert!(matches!(handle(&Emotes::default(), &end), Some(Event::Ended)));
    }

    #[test]
    fn gunzips_compressed_payloads() {
        use flate2::{write::GzEncoder, Compression};
        use std::io::Write;
        let inner = FetchResult { cursor: "c1".into(), need_ack: true, internal_ext: "ext".into(), ..Default::default() }.encode_to_vec();
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(&inner).unwrap();
        let decoded = FetchResult::decode(gunzip_if_needed(&gz.finish().unwrap()).unwrap().as_slice()).unwrap();
        assert_eq!(decoded.cursor, "c1");
        assert!(decoded.need_ack);
    }
}
