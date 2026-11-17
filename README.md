# Multi-Chat Stream Widget

A lightweight, self-hosted chat widget for OBS Studio that combines **Twitch, YouTube, Kick and TikTok** chat in one feed. Written in Rust with a [Tauri](https://tauri.app/) desktop window — no Node.js, no Electron, a ~10 MB app. YouTube chat is read without API limits, 7TV/BTTV/FFZ emotes work out of the box, and everything you see is plain HTML/CSS you can restyle.

## Features
* **Operating System:** Windows, macOS, and Linux
* **Unified Chat:** Twitch, YouTube, Kick and TikTok in a single chronological feed.
* **Native Emote Support:** Twitch, Kick and YouTube emotes, plus 7TV, BTTV, and FFZ.
* **Auto-Reconnect:** Every platform reconnects on its own (YouTube/TikTok check every 60 seconds whether you're live).
* **Three Modes:**
  * *Widget Mode:* Caps at 50 messages, hides scrollbars, transparent background (for OBS).
  * *Chat Mode:* Keeps 1000 messages, enables scrolling and "new message" alerts.
  * *Streamer Mode:* Chat plus an activity feed (subs, gifts, bits, raids, Super Chats, TikTok gifts & follows) and a "Live on:" status for every connected platform.
* **Mention Highlighting:** Highlights messages that mention your Twitch username.
* **Live Settings UI:** Press `T` (or the gear in Streamer Mode) to change channels, themes and modes on the fly.
* **9 Built-in Themes:** Dark Pill, Cyberpunk, Glassmorphic, Retro Arcade, MMO Chat Log, RPG Dialog (typewriter), Neon Tag, Cozy Pastel, Sci-Fi HUD.
* **Theme Editor:** *Settings → Display → Open Theme Editor* (or `/editor.html`) — design your own theme with a live preview, no coding needed. See [Custom themes](#custom-themes).
* **Virtual Mode:** Simulated chat on all four platforms for testing, without any network connection to them.

## Quick Start
Grab the app from the [Releases](../../releases) tab:
* **Windows:** `Multi-Chat_<version>_x64-setup.exe` (installer) or `Multi-Chat-portable-windows-x64.exe` (just double-click, nothing installed). Uses the WebView2 runtime that ships with Windows 10/11.
* **macOS:** `Multi-Chat_<version>_aarch64.dmg`. The build isn't code-signed: right-click the app and choose "Open" the first time (or run `xattr -d com.apple.quarantine "/Applications/Multi-Chat.app"`).
* **Linux:** `.AppImage` (`chmod +x`, then run) or `.deb`.

A window opens with the chat. On first start a setup popup asks for your channels — fill in any of Twitch, YouTube, Kick or TikTok. The app serves everything on **port `41414`** (`http://localhost:41414`).

**Settings & data folder** (`config.json`, `custom-themes/`, `web/`):
* Windows: `%APPDATA%\multi-chat` · macOS: `~/Library/Application Support/multi-chat` · Linux: `~/.config/multi-chat`
* **Portable mode:** put a `config.json` next to the executable (e.g. on a USB stick) and the app keeps all its data there instead.
* Settings from the old Electron version are picked up automatically (same folder).

**Command line options** (desktop app and headless server):
```
--virtual            simulated chat, no platform connections (alias: --dev)
--port=48213         use another port (or "port": 48213 in config.json, or the PORT env var)
--data-dir=<path>    keep config and themes in a specific folder
```

## Usage
1. **For OBS Studio:** Add a "Browser Source", uncheck "Local File", and set the URL to `http://localhost:41414`.
   * **URL overrides:** lock OBS into a specific look while you change settings freely in the app:
     `http://localhost:41414/?mode=widget&bg=transparent&theme=glassmorphic`
     * `mode=` (`widget`, `chat` or `streamer`)
     * `bg=` (`transparent` or `dark`)
     * `theme=` (`dark-pill`, `cyberpunk`, `glassmorphic`, `retro-arcade`, `mmo-log`, `rpg-dialog`, `neon-tag`, `cozy-pastel`, `scifi-hud`, or `custom-<name>` for your own)
     * `pos=` (`left` or `right` — activity feed position in Streamer Mode)
   * OBS on a second PC? Use `http://<this-pc's-ip>:41414`.
2. **For moderation/reading:** use the app window (or any browser on the same URL). Press `T` for settings.

*(Changes in the app or browser instantly update the widget in OBS — no refresh needed.)*

### Platform notes
* **Twitch:** read-only anonymous connection, no login needed.
* **YouTube:** enter your channel ID (`UC…`, find it on your channel page) or a live video URL.
* **Kick:** your username or `kick.com/<name>`. Kick sometimes blocks automated channel lookups; the app retries every 30 seconds.
* **TikTok:** your `@username`; only connects while you're live. Uses the third-party [Euler Stream](https://www.eulerstream.com/) sign server (the same one `tiktok-live-connector` uses), which receives the room id. If you hit its free rate limit, add `"tiktokSignApiKey": "<your key>"` to `config.json`.

## Custom themes
Everything in the chat is plain HTML/CSS:
* **Theme editor:** pick a preset, adjust layout/colors/borders/animations with a live preview, and *Save to My Themes*. Saved themes appear under *My Themes* in the theme dropdown immediately.
* **Hand-written CSS:** drop any `.css` file into `custom-themes/` in the data folder. Start it with `/* @name: My Theme */` to give it a display name. Open chats **hot-reload** whenever a theme file is added, edited or removed. Useful hooks: `.message`, `.platform-icon`, `.author-name`, `.text`, `.message[data-platform="Twitch"]`, `var(--user-color)`, `var(--platform-color)`, and `body { --typewriter: 1; }` for the letter-by-letter effect. The built-in themes in [`public/themes/`](public/themes) are good examples.
* **Override any page:** files in the data folder's `web/` subfolder replace the built-in ones with the same path (e.g. `web/index.html`, `web/css/app.css`), so you can change the whole layout without rebuilding the app.

## Building from source
Requirements: [Rust](https://rustup.rs/) (stable) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS (on Windows: WebView2 + MSVC build tools; on Linux: `libwebkit2gtk-4.1-dev` and friends). Node.js is **not** needed.

```bash
cargo install tauri-cli --version "^2" --locked   # once

cargo tauri dev -- -- --virtual    # run the desktop app in virtual mode
cargo tauri build                  # installers/bundles in target/release/bundle/, plain exe in target/release/
cargo test -p multichat-core       # unit + end-to-end tests
```

### Headless server (no window)
For a VPS or any machine where you'd rather use a browser:
```bash
cargo run --release -p multichat-core --bin multichat-server -- --virtual
```
Release builds also ship `multichat-server-<os>` binaries.

### Project layout
```
public/                     the web UI: chat page, theme editor, themes (compiled into the binary)
crates/multichat-core/      server, platform connections, themes, config (Rust library + headless binary)
  src/services/             one module per platform: twitch.rs, youtube.rs, kick.rs, tiktok.rs
src-tauri/                  the desktop window (starts the core server, shows the chat page)
```
None of the builds are code-signed, so Windows/macOS may show an "unknown publisher" warning on first launch — expected for an app without a paid signing certificate.
