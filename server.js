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

app.use(express.static('public'));

// Cache up to 1000 messages in memory
let messageHistory = [];
const MAX_HISTORY = 1000;

function handleIncomingMessage(msgData) {
    messageHistory.push(msgData);
    if (messageHistory.length > MAX_HISTORY) {
        messageHistory.shift();
    }
    io.emit('chatMessage', msgData);
}

const TWITCH_CHANNEL = process.env.TWITCH_CHANNEL; 
const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID;
const PORT = process.env.PORT || 8080;

const thirdPartyEmotes = {};

async function loadExternalEmotes(roomId) {
    console.log(`Fetching 7TV, BTTV, and FFZ emotes for Twitch Room ID: ${roomId}...`);
    
    // 7TV (Global & Channel)
    try {
        const stvGlobal = await fetch('https://7tv.io/v3/emote-sets/global').then(r => r.json());
        stvGlobal.emotes.forEach(e => thirdPartyEmotes[e.name] = `https://cdn.7tv.app/emote/${e.id}/1x.webp`);
        const stvChannel = await fetch(`https://7tv.io/v3/users/twitch/${roomId}`).then(r => r.json());
        if (stvChannel.emote_set) {
            stvChannel.emote_set.emotes.forEach(e => thirdPartyEmotes[e.name] = `https://cdn.7tv.app/emote/${e.id}/1x.webp`);
        }
    } catch(e) { console.log("7TV skipped or failed."); }

    // BTTV (Global & Channel)
    try {
        const bttvGlobal = await fetch('https://api.betterttv.net/3/cached/emotes/global').then(r => r.json());
        bttvGlobal.forEach(e => thirdPartyEmotes[e.code] = `https://cdn.betterttv.net/emote/${e.id}/1x`);
        const bttvChannel = await fetch(`https://api.betterttv.net/3/cached/users/twitch/${roomId}`).then(r => r.json());
        [...(bttvChannel.channelEmotes || []), ...(bttvChannel.sharedEmotes || [])].forEach(e => {
            thirdPartyEmotes[e.code] = `https://cdn.betterttv.net/emote/${e.id}/1x`;
        });
    } catch(e) { console.log("BTTV skipped or failed."); }

    // FFZ (Global & Channel)
    try {
        const ffzGlobal = await fetch('https://api.frankerfacez.com/v1/set/global').then(r => r.json());
        ffzGlobal.default_sets.forEach(set => {
            ffzGlobal.sets[set].emoticons.forEach(e => thirdPartyEmotes[e.name] = `https://cdn.frankerfacez.com/emote/${e.id}/1`);
        });
        const ffzChannel = await fetch(`https://api.frankerfacez.com/v1/room/id/${roomId}`).then(r => r.json());
        const ffzSet = ffzChannel.room.set;
        ffzChannel.sets[ffzSet].emoticons.forEach(e => thirdPartyEmotes[e.name] = `https://cdn.frankerfacez.com/emote/${e.id}/1`);
    } catch(e) { console.log("FFZ skipped or failed."); }

    console.log(`✅ Loaded ${Object.keys(thirdPartyEmotes).length} custom emotes into memory!`);
}

function parseThirdParty(text) {
    return text.split(' ').map(word => {
        if (thirdPartyEmotes[word]) return `<img src="${thirdPartyEmotes[word]}" class="emote" alt="${word}">`;
        return word;
    }).join(' ');
}

function formatTwitchMessage(message, emotesTags) {
    let replacements = [];
    
    // Process Native Twitch Emotes First
    if (emotesTags) {
        for (const [emoteId, placements] of Object.entries(emotesTags)) {
            for (const placement of placements) {
                const [start, end] = placement.split('-').map(Number);
                replacements.push({
                    start, end, 
                    html: `<img src="https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/dark/1.0" class="emote">`
                });
            }
        }
    }
    
    // Sort replacements to process string sequentially safely
    replacements.sort((a, b) => a.start - b.start);
    
    let finalHtml = "";
    let currentIndex = 0;
    
    for (const rep of replacements) {
        let textBefore = message.substring(currentIndex, rep.start);
        finalHtml += parseThirdParty(textBefore) + rep.html;
        currentIndex = rep.end + 1;
    }
    finalHtml += parseThirdParty(message.substring(currentIndex));
    return finalHtml;
}

// --- TWITCH SETUP ---
const twitchClient = new tmi.Client({ channels: [TWITCH_CHANNEL] });

twitchClient.on("roomstate", (channel, state) => {
    if (state["room-id"] && Object.keys(thirdPartyEmotes).length === 0) {
        loadExternalEmotes(state["room-id"]);
    }
});

twitchClient.on('connected', () => {
    io.emit('systemMessage', { 
        text: '✅ Connected to Twitch Chat!', 
        color: '#9146FF' 
    });
});

twitchClient.connect();
twitchClient.on('message', (channel, tags, message, self) => {
    handleIncomingMessage({
        platform: 'Twitch',
        author: tags['display-name'],
        message: formatTwitchMessage(message, tags.emotes),
        color: tags['color'] || '#9146FF'
    });
});

// --- YOUTUBE SETUP ---
let ytChat;
function startYouTube() {
    ytChat = new LiveChat({ channelId: YOUTUBE_CHANNEL_ID });

    ytChat.on('start', () => {
        io.emit('systemMessage', { 
            text: '✅ Connected to YouTube Chat!', 
            color: '#FF0000' 
        });
    });

    ytChat.on('chat', (chatItem) => {
        let finalHtml = "";
        chatItem.message.forEach(m => {
            if (m.url) finalHtml += `<img src="${m.url}" class="emote"> `;
            else if (m.text) finalHtml += parseThirdParty(m.text) + " ";
        });
        
        handleIncomingMessage({
            platform: 'YouTube',
            author: chatItem.author.name,
            message: finalHtml.trim(),
            color: '#FF0000'
        });
    });

    ytChat.on('error', (err) => {
        console.log("YouTube chat dropped. Retrying in 60 seconds...");
        if (ytChat) ytChat.stop();
        setTimeout(startYouTube, 60000);
    });

    ytChat.start().catch(err => {
        console.log("YouTube not live. Retrying in 60 seconds...");
        setTimeout(startYouTube, 60000);
    });
}
startYouTube();


io.on('connection', (socket) => {
    const configPath = path.join(__dirname, 'config.json');
    let currentConfig = { theme: 'dark-pill', background: 'transparent', mode: 'widget', mentions: true };
    
    try {
        if (fs.existsSync(configPath)) currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) { console.error(err); }
    
    currentConfig.streamerName = TWITCH_CHANNEL;
    
    socket.emit('loadConfig', currentConfig);
    socket.emit('chatHistory', messageHistory);

    socket.on('updateConfig', (newSettings) => {
        currentConfig = { ...currentConfig, ...newSettings };
        fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2));
        io.emit('loadConfig', currentConfig); 
    });
});

// --- START SERVER ---
server.listen(PORT, () => {
    console.log(`Chat widget running on http://localhost:${PORT}`);
});