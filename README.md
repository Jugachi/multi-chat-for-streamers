# Multi-Chat Stream Widget

A lightweight, self-hosted chat widget for OBS Studio that combines Twitch and YouTube chat. It bypasses YouTube API limits by scraping the live chat directly, supports 7TV/BTTV/FFZ emotes natively, and features a real-time WebSocket settings menu.

## Features
* **Operating System:** Supports any OS (Windows, Linux)
* **Unified Chat:** Combines Twitch and YouTube into a single chronological feed.
* **Native Emote Support:** Fetches and displays 7TV, BTTV, and FFZ emotes automatically.
* **Auto-Reconnect:** Checks YouTube every 60 seconds if you aren't currently live.
* **Two Modes:** 
  * *Widget Mode:* Caps at 50 messages, hides scrollbars, transparent background (For OBS).
  * *Chat Mode:* Keeps 1000 messages in memory, enables scrolling and "new message" alerts.
* **Mention Highlighting:** Visually highlights messages that mention your Twitch username.
* **Live Settings UI:** Press `T` in the browser to change themes and modes on the fly.

## Prerequisites
Ensure Node.js is installed on your Arch system:
```bash
sudo pacman -S nodejs npm
```

## Setup & Installation
1. Clone or download this repository.
2. Install the required dependencies:
   ```bash
   npm install express socket.io tmi.js youtube-chat dotenv
   ```
3. Copy the example.env file to .env and fill out your information!
    ```bash
    cp example.env .env
    ```
   *(Note: Find your YouTube Channel ID by going to your channel page. It usually starts with `UC...`)*

## Usage
1. Start the server:
   ```bash
   node server.js
   ```
2. **For OBS Studio:** Add a new "Browser Source", uncheck "Local File", and set the URL to `http://localhost:PORT` (default is `8080`). Set the width/height to your preference.
   * **Pro Tip (URL Overrides):** You can force specific settings for your OBS source by adding query parameters to the URL. This allows you to lock OBS into a transparent widget layout, while you safely change themes or use the full "Chat Mode" in your personal browser!
   * **Example URL:** `http://localhost:8080/?mode=widget&bg=transparent&theme=glassmorphic`
   * **Available Parameters:**
     * `mode=` (`widget` or `chat`)
     * `bg=` (`transparent` or `dark`)
     * `theme=` (`dark-pill`, `cyberpunk`, `glassmorphic`, or `retro-arcade`)
3. **For Moderation/Reading:** Open a regular web browser and navigate to the same local URL. Press T to open the settings menu and switch to "Chat Mode" and "Dark Background".

*(Note: Changes made in the web browser will automatically and instantly update the widget running inside OBS Studio without needing a refresh!)*
