// Entry point: web server + socket.io wiring. Platform logic lives in src/services,
// shared state in src/hub.js, simulated chat in src/virtual.js.
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const { isElectron, loadConfig, writeConfig } = require('./src/config');
const hub = require('./src/hub');
const services = require('./src/services');
const virtual = require('./src/virtual');
const themes = require('./src/themes');

// 'open' ships as an ESM-only package; dynamic import keeps this CJS file compatible with it.
function openBrowser(url) {
    return import('open').then(({ default: open }) => open(url));
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
hub.attach(io);

app.use(express.static(path.join(__dirname, 'public')));

// Theme list/save API + /custom-themes, and push changes to every open chat.
themes.registerRoutes(app);
themes.watchThemes((list) => io.emit('themesChanged', { themes: list, version: Date.now() }));

const startupConfig = loadConfig();
const isDevMode = process.argv.includes('--dev') || process.argv.includes('--virtual');

// Port priority: --port=1234 flag, then PORT env var, then config.json, then default.
const portArg = process.argv.find(a => a.startsWith('--port='));
const PORT = parseInt(portArg ? portArg.split('=')[1] : process.env.PORT, 10) || startupConfig.port || 41414;

function configuredStreams(cfg) {
    const streams = {};
    for (const svc of Object.values(services)) streams[svc.key] = cfg[svc.configKey] || '';
    return streams;
}

function saveStreamConfig(streams) {
    const cfg = loadConfig();
    for (const svc of Object.values(services)) cfg[svc.configKey] = streams[svc.key];
    writeConfig(cfg);
}

const hasAnyStream = () => Object.values(hub.streams).some(Boolean);

// Payload fields the client reads to pre-fill the stream inputs.
function activeStreams() {
    return {
        activeTwitch: hub.streams.twitch,
        activeYouTube: hub.streams.youtube,
        activeKick: hub.streams.kick,
        activeTikTok: hub.streams.tiktok
    };
}

// Start initial connections from config
const initialStreams = configuredStreams(startupConfig);
if (isDevMode) {
    virtual.start(initialStreams);
} else {
    for (const svc of Object.values(services)) {
        if (initialStreams[svc.key]) svc.connect(initialStreams[svc.key]);
    }
}

// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
    let currentConfig = loadConfig();
    currentConfig.streamerName = hub.streams.twitch;

    // Check if First Time Setup is required
    const needsSetup = !isDevMode && !hasAnyStream();

    socket.emit('loadConfig', { ...currentConfig, needsSetup, ...activeStreams() });
    socket.emit('serviceStatus', hub.serviceStatus);
    socket.emit('chatHistory', hub.messageHistory);
    socket.emit('activityHistory', hub.activityHistory);

    if (isDevMode) {
        socket.emit('systemMessage', { text: 'Virtual mode: simulated chat active', platform: 'virtual', id: 'dev' });
    } else {
        for (const [key, svc] of Object.entries(hub.serviceStatus)) {
            if (svc.state === 'connected') socket.emit('systemMessage', hub.connectedMessage(key));
        }
    }

    socket.on('updateConfig', (newSettings) => {
        currentConfig = { ...currentConfig, ...newSettings };
        writeConfig(currentConfig);
        io.emit('loadConfig', { ...currentConfig, needsSetup: false });
    });

    // Handle Stream Switching / First Time Setup
    socket.on('updateStreams', (data) => {
        const streams = {};
        for (const svc of Object.values(services)) streams[svc.key] = svc.normalize((data || {})[svc.key]);
        saveStreamConfig(streams);

        if (isDevMode) {
            virtual.setStreams(streams);
        } else {
            for (const svc of Object.values(services)) {
                if (streams[svc.key] !== hub.streams[svc.key]) svc.connect(streams[svc.key]);
            }
        }

        currentConfig = { ...loadConfig(), streamerName: streams.twitch };
        io.emit('loadConfig', { ...currentConfig, needsSetup: false, ...activeStreams() });
    });
});

// --- START SERVER ---
server.listen(PORT, () => {
    console.log(`Chat widget running on http://localhost:${PORT}`);

    // Check if the user needs to do the first-time setup
    if (isDevMode) {
        console.log(`\nOpen http://localhost:${PORT} in your browser to see the simulated chat.`);
    } else if (!hasAnyStream()) {
        console.log(`\n=============================================================`);
        console.log(`FIRST-TIME SETUP REQUIRED`);
        console.log(`=============================================================`);
        console.log(`It looks like you haven't configured your stream channels yet!`);
        console.log(`\nYou have two easy ways to get started:`);
        console.log(`  1. Web Setup: Open http://localhost:${PORT} in your`);
        console.log(`     web browser and use the welcome popup to connect.`);
        console.log(`  2. Manual Setup: Edit 'config.json' and add your`);
        console.log(`     "twitchChannel" / "youtubeChannel" / "kickChannel" /`);
        console.log(`     "tiktokUsername" fields, then restart.`);
        console.log(`=============================================================\n`);
        if (!isElectron) openBrowser(`http://localhost:${PORT}`).catch(() => {});
    } else {
        console.log(`\nWaking up the chat goblins and brewing coffee for the Twitch bots...`);
        console.log(`Give it just a moment to fully connect to your streams!`);
    }
});

// Lets electron/main.js host a window over this server once it's listening.
module.exports = { server, PORT };
