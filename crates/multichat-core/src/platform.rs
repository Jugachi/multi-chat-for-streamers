//! The supported streaming platforms and their fixed metadata.

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Platform {
    Twitch,
    YouTube,
    Kick,
    TikTok,
}

impl Platform {
    pub const ALL: [Platform; 4] = [Platform::Twitch, Platform::YouTube, Platform::Kick, Platform::TikTok];

    /// Id used in socket payloads and status maps.
    pub fn key(self) -> &'static str {
        match self {
            Platform::Twitch => "twitch",
            Platform::YouTube => "youtube",
            Platform::Kick => "kick",
            Platform::TikTok => "tiktok",
        }
    }

    /// Display name, also used as `platform` in chat messages (the client maps it to icons).
    pub fn name(self) -> &'static str {
        match self {
            Platform::Twitch => "Twitch",
            Platform::YouTube => "YouTube",
            Platform::Kick => "Kick",
            Platform::TikTok => "TikTok",
        }
    }

    /// Field name in config.json.
    pub fn config_key(self) -> &'static str {
        match self {
            Platform::Twitch => "twitchChannel",
            Platform::YouTube => "youtubeChannel",
            Platform::Kick => "kickChannel",
            Platform::TikTok => "tiktokUsername",
        }
    }

    /// Field the client reads to pre-fill the stream inputs.
    pub fn active_key(self) -> &'static str {
        match self {
            Platform::Twitch => "activeTwitch",
            Platform::YouTube => "activeYouTube",
            Platform::Kick => "activeKick",
            Platform::TikTok => "activeTikTok",
        }
    }

    pub fn brand_color(self) -> &'static str {
        match self {
            Platform::Twitch => "#9146FF",
            Platform::YouTube => "#FF0000",
            Platform::Kick => "#53FC18",
            Platform::TikTok => "#FF0050",
        }
    }

    pub fn index(self) -> usize {
        self as usize
    }

    pub fn from_key(key: &str) -> Option<Platform> {
        Platform::ALL.into_iter().find(|p| p.key() == key)
    }
}
