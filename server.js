const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const tmi = require('tmi.js');
const { LiveChat } = require('youtube-chat');
const fs = require('fs');
const path = require('path');

// 'open' ships as an ESM-only package; dynamic import keeps this CJS file compatible with it.
function openBrowser(url) {
    return import('open').then(({ default: open }) => open(url));
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// When packaged with pkg, __dirname points inside the read-only snapshot, so
// config.json must live next to the executable instead. Under Electron, the
// app is read-only (asar) and its install folder isn't reliably writable
// (e.g. Program Files on Windows), so use the standard per-user data folder.
const isElectron = !!process.versions.electron;
const isPkg = typeof process.pkg !== 'undefined';
const baseDir = isElectron
    ? require('electron').app.getPath('userData')
    : isPkg
        ? path.dirname(process.execPath)
        : __dirname;

app.use(express.static(path.join(__dirname, 'public')));

const configPath = path.join(baseDir, 'config.json');
const defaultConfig = { theme: 'dark-pill', background: 'transparent', mode: 'widget', mentions: true };

function loadConfig() {
    try { if (fs.existsSync(configPath)) return { ...defaultConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }; }
    catch (err) { console.error(err); }
    return { ...defaultConfig };
}

function writeConfig(cfg) {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

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

let startupConfig = loadConfig();
let activeTwitch = startupConfig.twitchChannel || '';
let activeYouTube = startupConfig.youtubeChannel || '';
let systemStatus = { twitch: false, youtube: false };
let PORT = startupConfig.port || 41414;
let thirdPartyEmotes = {};

function saveStreamConfig(twitch, youtube) {
    let cfg = loadConfig();
    cfg.twitchChannel = twitch || '';

    if (youtube) {
        if (youtube.startsWith('UC') && youtube.length === 24) {
            cfg.youtubeChannel = youtube;
        } else {
            // Extract Video ID if it's a URL
            let videoId = youtube;
            const match = youtube.match(/(?:v=|youtu\.be\/)([^&?]+)/);
            if (match) videoId = match[1];
            cfg.youtubeChannel = videoId;
        }
    } else {
        cfg.youtubeChannel = '';
    }

    writeConfig(cfg);
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

// --- DEV MODE (fake chat spam for testing without real streams) ---
const isDevMode = process.argv.includes('--dev');

function startDevMode() {
    console.log('\n🧪 DEV MODE: Simulating fake Twitch/YouTube chat activity...\n');
    systemStatus.twitch = true;
    systemStatus.youtube = true;

    const usernames = [
        'PixelPanda', 'NoScopeNancy', 'ChatGoblin', 'xX_Speedrunner_Xx', 'CouchPotato99',
        'GigaChad_Gaming', 'lurker_larry', 'MoonlitMage', 'BasementDweller', 'QuesoQueen',
        'YeetMaster3000', 'SleepyOtter', 'CrtHum', 'FrostyMemes', 'ZeroLatencyZane',
        'WanderingWizard', 'ToastedToast', 'GlitchInTheMatrix', 'PogChampion', 'NoodleArms',
        'Sir_Loses_Alot', 'CaffeineOverdose', 'DankMemeDealer', 'ButtonMasher42', 'EmoteSpammer',
        'ShyViewer', 'LagSwitchLuke', 'RainbowRaptor', 'BoxOfFrogs', 'InfiniteRespawn'
    ];

    const messages = [
        'LETS GOOO 🔥', 'wait what just happened lol', 'W stream', 'chat is this real',
        'POGGERS', 'no shot 💀', 'first time catching this live!', 'gg', 'the algorithm brought me here',
        'can we get a hype train going', 'this is peak content', 'clip that clip THAT',
        'monkaS', 'im dead 😂😂😂', 'hello from Germany!', 'how long has this stream been going',
        'ratio', 'been here since day one 🙌', 'wait thats actually smart', 'sending good vibes',
        'anyone else lagging or just me', 'the music slaps', '5Head strategy right there',
        'F in the chat', 'lurking but had to say hi', 'okay THAT was clean', 'chat please calm down',
        'is this a rerun', 'new sub who dis', 'take my bits 💎'
    ];

    const colors = [
        '#FF4500', '#1E90FF', '#00FF7F', '#9146FF', '#FF69B4', '#FFD700',
        '#00CED1', '#FF6347', '#7B68EE', '#ADFF2F', '#DAA520', '#20B2AA'
    ];

    function randomItem(arr) {
        return arr[Math.floor(Math.random() * arr.length)];
    }

    function sendFakeMessage() {
        const platform = Math.random() < 0.7 ? 'Twitch' : 'YouTube';
        handleIncomingMessage({
            platform,
            author: randomItem(usernames),
            message: randomItem(messages),
            color: platform === 'Twitch' ? randomItem(colors) : '#FF0000'
        });
        setTimeout(sendFakeMessage, 400 + Math.random() * 1600);
    }

    const activityGenerators = [
        () => ({ type: 'sub', text: `⭐ ${randomItem(usernames)} just subscribed!` }),
        () => ({ type: 'resub', text: `🌟 ${randomItem(usernames)} resubscribed for ${1 + Math.floor(Math.random() * 24)} months!` }),
        () => ({ type: 'gift', text: `🎁 ${randomItem(usernames)} gifted a sub to ${randomItem(usernames)}!` }),
        () => ({ type: 'bits', text: `💎 ${randomItem(usernames)} cheered ${randomItem([100, 250, 500, 1000, 5000])} bits!` }),
        () => ({ type: 'raid', text: `🚀 ${randomItem(usernames)} is raiding with ${1 + Math.floor(Math.random() * 200)} viewers!` })
    ];

    function sendFakeActivity() {
        handleActivity(randomItem(activityGenerators)());
        setTimeout(sendFakeActivity, 4000 + Math.random() * 8000);
    }

    sendFakeMessage();
    sendFakeActivity();
}

// Start initial connections if config data exists
if (isDevMode) {
    startDevMode();
} else {
    if (activeTwitch) connectTwitch(activeTwitch);
    if (activeYouTube) connectYouTube(activeYouTube);
}

// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
    let currentConfig = loadConfig();
    currentConfig.streamerName = activeTwitch;

    // Check if First Time Setup is required
    const needsSetup = !isDevMode && !activeTwitch && !activeYouTube;

    socket.emit('loadConfig', { ...currentConfig, needsSetup, activeTwitch, activeYouTube });
    socket.emit('chatHistory', messageHistory);
    socket.emit('activityHistory', activityHistory);

    if (isDevMode) {
        socket.emit('systemMessage', { text: '🧪 Dev Mode: Simulated chat active', color: '#00FF7F', id: 'dev' });
    } else {
        if (systemStatus.twitch) socket.emit('systemMessage', { text: `✅ Connected to Twitch: ${activeTwitch}`, color: '#9146FF', id: 'twitch' });
        if (systemStatus.youtube) socket.emit('systemMessage', { text: `✅ Connected to YouTube!`, color: '#FF0000', id: 'youtube' });
    }

    socket.on('updateConfig', (newSettings) => {
        currentConfig = { ...currentConfig, ...newSettings };
        writeConfig(currentConfig);
        io.emit('loadConfig', { ...currentConfig, needsSetup: false });
    });

    // Handle Stream Switching / First Time Setup
    socket.on('updateStreams', (data) => {
        saveStreamConfig(data.twitch, data.youtube);
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
    if (isDevMode) {
        console.log(`\nOpen http://localhost:${PORT} in your browser to see the simulated chat.`);
    } else if (!activeTwitch && !activeYouTube) {
        console.log(`\n=============================================================`);
        console.log(`FIRST-TIME SETUP REQUIRED`);
        console.log(`=============================================================`);
        console.log(`It looks like you haven't configured your stream channels yet!`);
        console.log(`\nYou have two easy ways to get started:`);
        console.log(`  1. Web Setup: Open http://localhost:${PORT} in your`);
        console.log(`     web browser and use the welcome popup to connect.`);
        console.log(`  2. Manual Setup: Edit 'config.json' and add your`);
        console.log(`     "twitchChannel" / "youtubeChannel" fields, then restart.`);
        console.log(`=============================================================\n`);
        if (!isElectron) openBrowser(`http://localhost:${PORT}`).catch(() => {});
    } else {
        console.log(`\nWaking up the chat goblins and brewing coffee for the Twitch bots...`);
        console.log(`Give it just a moment to fully connect to your streams!`);
    }
});

// Lets electron/main.js host a window over this server once it's listening.
module.exports = { server, PORT };