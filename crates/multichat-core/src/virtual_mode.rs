//! Virtual / dev mode: fake chat and fake connections for testing.
//! Nothing here touches the network, so it works where the platforms are blocked.

use crate::emotes::Emotes;
use crate::html::escape;
use crate::hub::{Activity, ChatMessage, ConnState, Hub};
use crate::platform::Platform;
use std::sync::Arc;
use std::time::Duration;

const USERNAMES: &[&str] = &[
    "PixelPanda", "NoScopeNancy", "ChatGoblin", "xX_Speedrunner_Xx", "CouchPotato99",
    "GigaChad_Gaming", "lurker_larry", "MoonlitMage", "BasementDweller", "QuesoQueen",
    "YeetMaster3000", "SleepyOtter", "CrtHum", "FrostyMemes", "ZeroLatencyZane",
    "WanderingWizard", "ToastedToast", "GlitchInTheMatrix", "PogChampion", "NoodleArms",
    "Sir_Loses_Alot", "CaffeineOverdose", "DankMemeDealer", "ButtonMasher42", "EmoteSpammer",
    "ShyViewer", "LagSwitchLuke", "RainbowRaptor", "BoxOfFrogs", "InfiniteRespawn",
];

// Viewers' own emojis stay as normal emojis in chat.
const MESSAGES: &[&str] = &[
    "LETS GOOO 🔥", "wait what just happened lol", "W stream", "chat is this real",
    "POGGERS", "no shot 💀", "first time catching this live!", "gg", "the algorithm brought me here",
    "can we get a hype train going", "this is peak content", "clip that clip THAT",
    "monkaS", "im dead 😂😂😂", "hello from Germany!", "how long has this stream been going",
    "ratio", "been here since day one 🙌", "wait thats actually smart", "sending good vibes",
    "anyone else lagging or just me", "the music slaps", "5Head strategy right there",
    "F in the chat", "lurking but had to say hi", "okay THAT was clean", "chat please calm down",
    "is this a rerun", "new sub who dis", "take my bits 💎",
];

const COLORS: &[&str] = &[
    "#FF4500", "#1E90FF", "#00FF7F", "#9146FF", "#FF69B4", "#FFD700",
    "#00CED1", "#FF6347", "#7B68EE", "#ADFF2F", "#DAA520", "#20B2AA",
];

fn pick<T: Copy>(items: &[T]) -> T {
    items[fastrand::usize(..items.len())]
}

/// Rough share of chat per platform.
fn random_platform() -> Platform {
    match fastrand::u8(0..100) {
        0..=44 => Platform::Twitch,
        45..=64 => Platform::YouTube,
        65..=79 => Platform::Kick,
        _ => Platform::TikTok,
    }
}

/// Marks every service as virtually connected to the given channels
/// (empty channel = placeholder name).
pub fn set_streams(hub: &Hub, streams: &[String; 4]) {
    for p in Platform::ALL {
        let channel = &streams[p.index()];
        hub.set_stream(p, channel);
        let shown = if channel.is_empty() { format!("virtual-{}", p.key()) } else { channel.clone() };
        hub.update_status(p, |s| {
            s.state = ConnState::Connected;
            s.is_virtual = true;
            s.channel = shown;
            s.detail = format!("Simulated connection (no traffic to {})", p.name());
        });
    }
}

fn random_activity() -> Activity {
    let user = pick(USERNAMES);
    let (platform, kind, text) = match fastrand::u8(0..12) {
        0 => (Platform::Twitch, "sub", format!("{user} just subscribed!")),
        1 => (Platform::Twitch, "resub", format!("{user} resubscribed for {} months!", fastrand::u8(1..25))),
        2 => (Platform::Twitch, "gift", format!("{user} gifted a sub to {}!", pick(USERNAMES))),
        3 => (Platform::Twitch, "bits", format!("{user} cheered {} bits!", pick(&[100, 250, 500, 1000, 5000]))),
        4 => (Platform::Twitch, "raid", format!("{user} is raiding with {} viewers!", fastrand::u8(1..200))),
        5 => (Platform::Kick, "sub", format!("{user} just subscribed!")),
        6 => (Platform::Kick, "gift", format!("{user} gifted {} subs!", pick(&[1, 5, 10]))),
        7 => (Platform::Kick, "host", format!("{user} is hosting with {} viewers!", fastrand::u8(1..200))),
        8 => (Platform::TikTok, "gift", format!("{user} sent {}{}!", pick(&["", "5x ", "10x "]), pick(&["Rose", "TikTok", "Finger Heart", "Galaxy"]))),
        9 => (Platform::TikTok, "follow", format!("{user} followed!")),
        10 => (Platform::YouTube, "superchat", format!("{user} sent a Super Chat ({})!", pick(&["€2.00", "€5.00", "€20.00"]))),
        _ => (Platform::YouTube, "member", format!("{user} became a member!")),
    };
    Activity { platform: platform.name(), kind, text }
}

/// Starts the fake chat and activity generators (runs until the process exits).
pub fn start(hub: Arc<Hub>, emotes: Arc<Emotes>, streams: &[String; 4]) {
    println!("[virtual] Simulating Twitch/YouTube/Kick/TikTok connections and chat (no real connections)...");
    set_streams(&hub, streams);

    let chat_hub = hub.clone();
    tokio::spawn(async move {
        loop {
            let platform = random_platform();
            let color = match platform {
                Platform::YouTube | Platform::TikTok => platform.brand_color(),
                _ => pick(COLORS),
            };
            chat_hub.chat(ChatMessage {
                platform: platform.name(),
                author: escape(pick(USERNAMES)),
                message: emotes.parse(pick(MESSAGES)),
                color: color.into(),
            });
            tokio::time::sleep(Duration::from_millis(400 + fastrand::u64(0..1600))).await;
        }
    });

    tokio::spawn(async move {
        loop {
            hub.activity(random_activity());
            tokio::time::sleep(Duration::from_millis(4000 + fastrand::u64(0..8000))).await;
        }
    });
}
