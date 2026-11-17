//! Third-party Twitch emotes (7TV, BTTV, FFZ). Also applied to other platforms'
//! chat, since viewers often type the same emote codes there.

use crate::html::escape;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::RwLock;

#[derive(Default)]
pub struct Emotes {
    map: RwLock<HashMap<String, String>>,
}

impl Emotes {
    pub fn clear(&self) {
        self.map.write().unwrap().clear();
    }

    pub fn is_empty(&self) -> bool {
        self.map.read().unwrap().is_empty()
    }

    pub fn insert(&self, code: impl Into<String>, url: impl Into<String>) {
        self.map.write().unwrap().insert(code.into(), url.into());
    }

    /// Turns plain chat text into safe HTML, swapping emote codes for images.
    pub fn parse(&self, text: &str) -> String {
        let map = self.map.read().unwrap();
        text.split(' ')
            .map(|word| match map.get(word) {
                Some(url) => format!(r#"<img src="{}" class="emote" alt="{}">"#, escape(url), escape(word)),
                None => escape(word),
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Loads global + channel emotes for a Twitch room id. Failures are logged and skipped.
    pub async fn load_for_twitch_room(&self, http: &reqwest::Client, room_id: &str) {
        println!("Fetching 7TV, BTTV, and FFZ emotes for Twitch room {room_id}");
        let get = |url: String| async move {
            http.get(url).send().await.ok()?.json::<Value>().await.ok()
        };
        let arr = |v: &Value, key: &str| v.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
        let s = |v: &Value, key: &str| match v.get(key) {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Number(n)) => Some(n.to_string()),
            _ => None,
        };

        // 7TV (global + channel)
        let stv = |v: &Value| {
            for e in arr(v, "emotes") {
                if let (Some(name), Some(id)) = (s(&e, "name"), s(&e, "id")) {
                    self.insert(name, format!("https://cdn.7tv.app/emote/{id}/1x.webp"));
                }
            }
        };
        if let Some(v) = get("https://7tv.io/v3/emote-sets/global".into()).await {
            stv(&v);
        }
        if let Some(v) = get(format!("https://7tv.io/v3/users/twitch/{room_id}")).await {
            if let Some(set) = v.get("emote_set") {
                stv(set);
            }
        }

        // BTTV (global + channel + shared)
        let bttv = |list: Vec<Value>| {
            for e in list {
                if let (Some(code), Some(id)) = (s(&e, "code"), s(&e, "id")) {
                    self.insert(code, format!("https://cdn.betterttv.net/emote/{id}/1x"));
                }
            }
        };
        if let Some(Value::Array(list)) = get("https://api.betterttv.net/3/cached/emotes/global".into()).await {
            bttv(list);
        }
        if let Some(v) = get(format!("https://api.betterttv.net/3/cached/users/twitch/{room_id}")).await {
            bttv(arr(&v, "channelEmotes"));
            bttv(arr(&v, "sharedEmotes"));
        }

        // FFZ (global default sets + channel set)
        let ffz_set = |set: &Value| {
            for e in arr(set, "emoticons") {
                if let (Some(name), Some(id)) = (s(&e, "name"), s(&e, "id")) {
                    self.insert(name, format!("https://cdn.frankerfacez.com/emote/{id}/1"));
                }
            }
        };
        if let Some(v) = get("https://api.frankerfacez.com/v1/set/global".into()).await {
            for set_id in arr(&v, "default_sets") {
                if let Some(set) = v.get("sets").and_then(|sets| sets.get(set_id.to_string())) {
                    ffz_set(set);
                }
            }
        }
        if let Some(v) = get(format!("https://api.frankerfacez.com/v1/room/id/{room_id}")).await {
            let set_id = v.get("room").and_then(|r| r.get("set")).map(Value::to_string).unwrap_or_default();
            if let Some(set) = v.get("sets").and_then(|sets| sets.get(&set_id)) {
                ffz_set(set);
            }
        }

        println!("Loaded {} custom emotes", self.map.read().unwrap().len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_known_codes_and_escapes_the_rest() {
        let e = Emotes::default();
        e.insert("KEKW", "https://cdn.example/kekw");
        assert_eq!(
            e.parse("lol KEKW <b>"),
            r#"lol <img src="https://cdn.example/kekw" class="emote" alt="KEKW"> &lt;b&gt;"#
        );
    }
}
