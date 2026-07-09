# Multi-Chat Stream Widget

A lightweight, self-hosted chat widget for OBS Studio that combines Twitch and YouTube chat. It bypasses YouTube API limits by scraping the live chat directly, supports 7TV/BTTV/FFZ emotes natively, and features a real-time WebSocket settings menu.

## Features
* **Operating System:** Supports Windows, macOS, and Linux
* **Unified Chat:** Combines Twitch and YouTube into a single chronological feed.
* **Native Emote Support:** Fetches and displays 7TV, BTTV, and FFZ emotes automatically.
* **Auto-Reconnect:** Checks YouTube every 60 seconds if you aren't currently live.
* **Two Modes:** 
  * *Widget Mode:* Caps at 50 messages, hides scrollbars, transparent background (For OBS).
  * *Chat Mode:* Keeps 1000 messages in memory, enables scrolling and "new message" alerts.
  * *Streamer Mode:* Splits the screen to show Chat and a dedicated Twitch Activity feed (Subs, Gifts, Cheers, Raids) side-by-side.
* **Mention Highlighting:** Visually highlights messages that mention your Twitch username.
* **Live Settings UI:** Press `T` in the browser to change themes and modes on the fly.

## Quick Start (No Node.js required)
Grab a ready-to-run desktop app from the [Releases](../../releases) page — no Node.js install needed, no terminal, just a normal app window:
* **Windows:** `Multi-Chat 1.0.0.exe` — a portable app, just double-click it (no installer).
* **macOS:** `Multi-Chat-1.0.0-mac.zip` (Intel) or `Multi-Chat-1.0.0-arm64-mac.zip` (Apple Silicon) — unzip and open `Multi-Chat.app`. Since the build isn't code-signed, right-click it and choose "Open" the first time (or run `xattr -d com.apple.quarantine "Multi-Chat.app"`) to get past Gatekeeper.
* **Linux:** `Multi-Chat-1.0.0.AppImage` (or `-arm64.AppImage`) — `chmod +x` it, then double-click or run it.

A window opens showing the widget itself. If you haven't set a Twitch or YouTube channel yet, it'll show the first-time setup popup automatically so you can connect one — just fill it in right there in the window. Settings are stored per-user (`%APPDATA%\multi-chat` on Windows, `~/Library/Application Support/multi-chat` on macOS, `~/.config/multi-chat` on Linux), so they persist across app updates.

Skip ahead to [Usage](#usage) to point OBS at the widget. If you'd rather run it with Node.js directly, or want to build the app yourself, keep reading.

## Prerequisites
Ensure Node.js and npm are installed on your system before proceeding.

**Windows:**
* Download and install the "LTS" (Long Term Support) version from the [official Node.js website](https://nodejs.org/).

**macOS:**
* Download the installer from the [official Node.js website](https://nodejs.org/).

**Debian / Ubuntu / Pop!_OS:**
```bash
sudo apt update
sudo apt install nodejs npm
```

**Fedora:**
```bash
sudo dnf install nodejs npm
```

**Arch:**
```bash
sudo pacman -S nodejs npm
```

## Setup & Installation
1. Clone or download this repository.
2. Install the required dependencies:
   ```bash
   npm install express socket.io tmi.js youtube-chat
   ```
3. Either use the web-based first-time setup popup when you first launch the widget, or manually edit `config.json` and add your `twitchChannel` and `youtubeChannel` fields.
   *(Note: Find your YouTube Channel ID by going to your channel page. It usually starts with `UC...`)*

## Usage
1. Start the server:
   ```bash
   node server.js
   ```
2. **For OBS Studio:** Add a new "Browser Source", uncheck "Local File", and set the URL to `http://localhost:PORT` (default is `41414`). Set the width/height to your preference.
   * **Pro Tip (URL Overrides):** You can force specific settings for your OBS source by adding query parameters to the URL. This allows you to lock OBS into a transparent widget layout, while you safely change themes or use the full "Chat Mode" in your personal browser!
   * **Example URL:** `http://localhost:41414/?mode=widget&bg=transparent&theme=glassmorphic`
   * **Available Parameters:**
     * `mode=` (`widget` or `chat`)
     * `bg=` (`transparent` or `dark`)
     * `theme=` (`dark-pill`, `cyberpunk`, `glassmorphic`, or `retro-arcade`)
     * `pos=` (`left` or `right` - controls Activity Feed position in Streamer Mode)
3. **For Moderation/Reading:** Open a regular web browser and navigate to the same local URL. Press T to open the settings menu and switch to "Chat Mode" and "Dark Background".

*(Note: Changes made in the web browser will automatically and instantly update the widget running inside OBS Studio without needing a refresh!)*

## Building the desktop app yourself
Packaging is handled by [Electron](https://www.electronjs.org/) + [electron-builder](https://www.electron.build/), which wraps the same server + widget in a native window and bundles Node/Chromium so end users don't need anything installed.
```bash
npm install
npm run dist:linux   # -> release/*.AppImage (x64 + arm64)
npm run dist:win     # -> release/*.exe (portable, x64 + arm64 in one file)
npm run dist:mac     # -> release/*-mac.zip (x64 + arm64)
npm run dist         # builds all three
```
`electron/main.js` is the app entry point — it starts `server.js` internally and opens a `BrowserWindow` pointing at it once the server is listening. `public/` and `server.js` are bundled into the app's `asar` archive; `config.json` is intentionally **not** bundled — it lives in the OS's per-user app-data folder instead (see [Quick Start](#quick-start-no-nodejs-required)), so settings survive reinstalls/updates.

Building for macOS produces a `.zip` rather than a signed `.dmg`, since `.dmg` creation needs macOS-only tooling (`sips`/`hdiutil`) — build that target on an actual Mac if you need a `.dmg`. None of these builds are code-signed, so macOS/Windows may show an "unknown publisher" warning on first launch; that's expected for a self-built app without a paid signing certificate.

### Alternative: headless console build
There's also a lighter-weight, no-GUI option using [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg), useful for running on a headless machine (e.g. a VPS) where you'd just open the widget URL in a browser instead of a native window:
```bash
npm run build         # builds Windows, macOS (x64 + arm64), and Linux console binaries into dist/
npm run build:win      # or just one platform at a time
npm run build:mac
npm run build:linux
```
These binaries start the same server from a terminal/console window and auto-open your default browser to the settings page on first run, instead of showing their own window.
