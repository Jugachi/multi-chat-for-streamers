// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const tmi = require('tmi.js');
const { LiveChat } = require('youtube-chat');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the frontend files from the "public" folder
app.use(express.static('public'));

// --- THEME ROUTER ---
app.get('/theme.css', (req, res) => {
    try {
        // Read config.json dynamically on every page load/OBS refresh
        const configData = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
        const config = JSON.parse(configData);
        const themeName = config.theme || 'dark-pill';
        
        // Send the corresponding theme file
        res.sendFile(path.join(__dirname, 'public', 'themes', `${themeName}.css`));
    } catch (err) {
        console.error("Error loading theme config, falling back to default:", err);
        res.sendFile(path.join(__dirname, 'public', 'themes', 'dark-pill.css'));
    }
});

// --- CONFIGURATION ---
const TWITCH_CHANNEL = process.env.TWITCH_CHANNEL; 
const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID;

// --- TWITCH SETUP ---
const twitchClient = new tmi.Client({
    channels: [TWITCH_CHANNEL]
});

twitchClient.connect();
twitchClient.on('message', (channel, tags, message, self) => {
    io.emit('chatMessage', {
        platform: 'Twitch',
        author: tags['display-name'],
        message: message,
        color: tags['color'] || '#9146FF' // Default Twitch purple
    });
});

// --- YOUTUBE SETUP ---
// This will automatically find the active live stream for the given channel ID
const ytChat = new LiveChat({ channelId: YOUTUBE_CHANNEL_ID });

ytChat.on('chat', (chatItem) => {
    // YouTube messages can contain emojis which are split into arrays, 
    // this merges them back into a single text string.
    const text = chatItem.message.map(m => m.text || m.emojiText || '').join(' ');
    
    io.emit('chatMessage', {
        platform: 'YouTube',
        author: chatItem.author.name,
        message: text,
        color: '#FF0000' // Default YouTube red
    });
});

ytChat.start().catch(err => console.error("YouTube Chat Error. Are you live?:", err));


// --- LIVE SETTINGS SYNC ---
io.on('connection', (socket) => {
    // 1. When a browser connects, read the config and send it to them
    const configPath = path.join(__dirname, 'config.json');
    let currentConfig = { theme: 'dark-pill', background: 'transparent' };
    
    try {
        if (fs.existsSync(configPath)) {
            currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (err) {
        console.error("Error reading config:", err);
    }
    
    socket.emit('loadConfig', currentConfig);

    // 2. Listen for changes from the user pressing 'T' in the browser
    socket.on('updateConfig', (newSettings) => {
        currentConfig = { ...currentConfig, ...newSettings };
        
        // Save to file so it remembers for next stream
        fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2));
        
        // Broadcast the new settings to ALL connected browsers (including OBS)
        io.emit('loadConfig', currentConfig);
    });
});

// --- START SERVER ---
server.listen(3000, () => {
    console.log('Chat widget running on http://localhost:3000');
});