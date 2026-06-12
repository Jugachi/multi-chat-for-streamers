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

let activityHistory = [];
const MAX_ACTIVITY_HISTORY = 100;

function handleActivity(data) {
    activityHistory.push(data);
    if (activityHistory.length > MAX_ACTIVITY_HISTORY) activityHistory.shift();
    io.emit('activityMessage', data);
}

let activeTwitch = process.env.TWITCH_CHANNEL || '';
let activeYouTube = process.env.YOUTUBE_CHANNEL_ID || process.env.YOUTUBE_LIVE_ID || '';
let systemStatus = { twitch: false, youtube: false };
let PORT = process.env.PORT || 8080;
let thirdPartyEmotes = {};

function saveEnv(twitch, youtube) {
    let envData = `PORT=${process.env.PORT || 8080}\n`;
    if (twitch) envData += `TWITCH_CHANNEL=${twitch}\n`;

    if (youtube) {
        if (youtube.startsWith('UC') && youtube.length === 24) {
            envData += `YOUTUBE_CHANNEL_ID=${youtube}\n`;
        } else {
            // Extract Video ID if it's a URL
            let videoId = youtube;
            const match = youtube.match(/(?:v=|youtu\.be\/)([^&?]+)/);
            if (match) videoId = match[1];
            envData += `YOUTUBE_LIVE_ID=${videoId}\n`;
        }
    }
    fs.writeFileSync('.env', envData);
}

async function loadExternalEmotes(roomId) {
    console.log(`\nFetching 7TV, BTTV, and FFZ emotes for Twitch Room ID: ${roomId}`);

    // 7TV (Global & Channel)
    try {
        const stvGlobal = await fetch('https://7tv.io/v3/emote-sets/global').then(r => r.json());
        stvGlobal.emotes.forEach(e => thirdPartyEmotes[e.name] = `https://cdn.7tv.app/emote/${e.id}/1x.webp`);
        const stvChannel = await fetch(`https://7tv.io/v3/users/twitch/${roomId}`).then(r => r.json());
        if (stvChannel.emote_set) {
            stvChannel.emote_set.emotes.forEach(e => thirdPartyEmotes[e.name] = `https://cdn.7tv.app/emote/${e.id}/1x.webp`);
        }
    } catch (e) { console.log("7TV skipped or failed."); }

    // BTTV (Global & Channel)
    try {
        const bttvGlobal = await fetch('https://api.betterttv.net/3/cached/emotes/global').then(r => r.json());
        bttvGlobal.forEach(e => thirdPartyEmotes[e.code] = `https://cdn.betterttv.net/emote/${e.id}/1x`);
        const bttvChannel = await fetch(`https://api.betterttv.net/3/cached/users/twitch/${roomId}`).then(r => r.json());
        [...(bttvChannel.channelEmotes || []), ...(bttvChannel.sharedEmotes || [])].forEach(e => {
            thirdPartyEmotes[e.code] = `https://cdn.betterttv.net/emote/${e.id}/1x`;
        });
    } catch (e) { console.log("BTTV skipped or failed."); }

    // FFZ (Global & Channel)
    try {
        const ffzGlobal = await fetch('https://api.frankerfacez.com/v1/set/global').then(r => r.json());
        ffzGlobal.default_sets.forEach(set => {
            ffzGlobal.sets[set].emoticons.forEach(e => thirdPartyEmotes[e.name] = `https://cdn.frankerfacez.com/emote/${e.id}/1`);
        });
        const ffzChannel = await fetch(`https://api.frankerfacez.com/v1/room/id/${roomId}`).then(r => r.json());
        const ffzSet = ffzChannel.room.set;
        ffzChannel.sets[ffzSet].emoticons.forEach(e => thirdPartyEmotes[e.name] = `https://cdn.frankerfacez.com/emote/${e.id}/1`);
    } catch (e) { console.log("FFZ skipped or failed."); }

    console.log(`Loaded ${Object.keys(thirdPartyEmotes).length} custom emotes into memory!`);
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
let twitchClient;

function connectTwitch(channel) {
    if (!channel) return;

    // Clear old emotes when switching channels
    for (let key in thirdPartyEmotes) delete thirdPartyEmotes[key];

    if (twitchClient && twitchClient.readyState() === 'OPEN') {
        twitchClient.part(activeTwitch).then(() => twitchClient.join(channel)).catch(() => twitchClient.join(channel));
        activeTwitch = channel;
        return;
    }

    activeTwitch = channel;
    twitchClient = new tmi.Client({ channels: [activeTwitch] });

    twitchClient.on("roomstate", (channel, state) => {
        if (state["room-id"] && Object.keys(thirdPartyEmotes).length === 0) {
            loadExternalEmotes(state["room-id"]);
        }
    });

    twitchClient.on('connected', () => {
        systemStatus.twitch = true;
        io.emit('systemMessage', { text: `✅ Connected to Twitch: ${activeTwitch}`, color: '#9146FF', id: 'twitch' });
    });

    twitchClient.on('disconnected', () => systemStatus.twitch = false);

    twitchClient.on('message', (channel, tags, message, self) => {
        handleIncomingMessage({
            platform: 'Twitch', author: tags['display-name'],
            message: formatTwitchMessage(message, tags.emotes), color: tags['color'] || '#9146FF'
        });
    });

    // Activity Handlers
    twitchClient.on("subscription", (channel, username) => handleActivity({ type: 'sub', text: `⭐ ${username} just subscribed!` }));
    twitchClient.on("resub", (channel, username, months) => handleActivity({ type: 'resub', text: `🌟 ${username} resubscribed for ${months} months!` }));
    twitchClient.on("subgift", (channel, username, streak, recipient) => handleActivity({ type: 'gift', text: `🎁 ${username} gifted a sub to ${recipient}!` }));
    twitchClient.on("cheer", (channel, userstate) => handleActivity({ type: 'bits', text: `💎 ${userstate.username} cheered ${userstate.bits} bits!` }));
    twitchClient.on("raided", (channel, username, viewers) => handleActivity({ type: 'raid', text: `🚀 ${username} is raiding with ${viewers} viewers!` }));

    twitchClient.connect().catch(console.error);
}

// --- YOUTUBE SETUP ---
let ytChat;
let ytRetryTimeout;

function connectYouTube(input) {
    if (ytChat) {
        ytChat.stop();
        ytChat.removeAllListeners();
    }
    clearTimeout(ytRetryTimeout);
    if (!input) return;

    activeYouTube = input;
    let ytConfig = {};
    if (input.startsWith('UC') && input.length === 24) ytConfig = { channelId: input };
    else {
        let videoId = input;
        const match = input.match(/(?:v=|youtu\.be\/)([^&?]+)/);
        if (match) videoId = match[1];
        ytConfig = { liveId: videoId };
    }

    ytChat = new LiveChat(ytConfig);

    ytChat.on('start', () => {
        systemStatus.youtube = true;
        io.emit('systemMessage', { text: `✅ Connected to YouTube!`, color: '#FF0000', id: 'youtube' });
    });

    ytChat.on('chat', (chatItem) => {
        let finalHtml = "";
        chatItem.message.forEach(m => {
            if (m.url) finalHtml += `<img src="${m.url}" class="emote"> `;
            else if (m.text) finalHtml += parseThirdParty(m.text) + " ";
        });
        handleIncomingMessage({ platform: 'YouTube', author: chatItem.author.name, message: finalHtml.trim(), color: '#FF0000' });
    });

    ytChat.on('error', (err) => {
        systemStatus.youtube = false;
        console.log("YouTube chat dropped. Retrying in 60s...");
        if (ytChat) ytChat.stop();
        ytRetryTimeout = setTimeout(() => connectYouTube(activeYouTube), 60000);
    });

    ytChat.start().catch(err => {
        systemStatus.youtube = false;
        console.log("YouTube not live. Retrying in 60s...");
        ytRetryTimeout = setTimeout(() => connectYouTube(activeYouTube), 60000);
    });
}

// Start initial connections if .env data exists
if (activeTwitch) connectTwitch(activeTwitch);
if (activeYouTube) connectYouTube(activeYouTube);

// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
    const configPath = path.join(__dirname, 'config.json');
    let currentConfig = { theme: 'dark-pill', background: 'transparent', mode: 'widget', mentions: true };

    try { if (fs.existsSync(configPath)) currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch (err) { console.error(err); }

    currentConfig.streamerName = activeTwitch;

    // Check if First Time Setup is required
    const needsSetup = !fs.existsSync('.env') && !activeTwitch && !activeYouTube;

    socket.emit('loadConfig', { ...currentConfig, needsSetup, activeTwitch, activeYouTube });
    socket.emit('chatHistory', messageHistory);
    socket.emit('activityHistory', activityHistory);

    if (systemStatus.twitch) socket.emit('systemMessage', { text: `✅ Connected to Twitch: ${activeTwitch}`, color: '#9146FF', id: 'twitch' });
    if (systemStatus.youtube) socket.emit('systemMessage', { text: `✅ Connected to YouTube!`, color: '#FF0000', id: 'youtube' });

    socket.on('updateConfig', (newSettings) => {
        currentConfig = { ...currentConfig, ...newSettings };
        fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2));
        io.emit('loadConfig', { ...currentConfig, needsSetup: false });
    });

    // Handle Stream Switching / First Time Setup
    socket.on('updateStreams', (data) => {
        saveEnv(data.twitch, data.youtube);
        if (data.twitch !== activeTwitch) connectTwitch(data.twitch);
        if (data.youtube !== activeYouTube) connectYouTube(data.youtube);

        currentConfig.streamerName = data.twitch;
        io.emit('loadConfig', { ...currentConfig, needsSetup: false, activeTwitch: data.twitch, activeYouTube: data.youtube });
    });
});

// --- START SERVER ---
server.listen(PORT, () => {
    console.log(`Chat widget running on http://localhost:${PORT}`);

    // Check if the user needs to do the first-time setup
    if (!fs.existsSync('.env') && !activeTwitch && !activeYouTube) {
        console.log(`\n=============================================================`);
        console.log(`FIRST-TIME SETUP REQUIRED`);
        console.log(`=============================================================`);
        console.log(`It looks like you haven't configured your stream channels yet!`);
        console.log(`\nYou have two easy ways to get started:`);
        console.log(`  1. Web Setup: Open http://localhost:${PORT} in your`);
        console.log(`     web browser and use the welcome popup to connect.`);
        console.log(`  2. Manual Setup: Copy 'example.env', rename it to '.env',`);
        console.log(`     fill out your channel details, and restart this server.`);
        console.log(`=============================================================\n`);
    } else {
        console.log(`\nWaking up the chat goblins and brewing coffee for the Twitch bots...`);
        console.log(`Give it just a moment to fully connect to your streams!`);
    }
});