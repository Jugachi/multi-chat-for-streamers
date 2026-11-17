const tmi = require('tmi.js');
const hub = require('../hub');
const emotes = require('../emotes');
const { escapeHtml } = require('../utils/html');

const KEY = 'twitch';
let twitchClient = null;

function normalize(input) {
    return String(input || '').trim();
}

function formatMessage(message, emotesTags) {
    const replacements = [];

    // Process Native Twitch Emotes First
    if (emotesTags) {
        for (const [emoteId, placements] of Object.entries(emotesTags)) {
            for (const placement of placements) {
                const [start, end] = placement.split('-').map(Number);
                replacements.push({
                    start, end,
                    html: `<img src="https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(emoteId)}/default/dark/1.0" class="emote">`
                });
            }
        }
    }

    // Sort replacements to process string sequentially safely
    replacements.sort((a, b) => a.start - b.start);

    let finalHtml = "";
    let currentIndex = 0;
    for (const rep of replacements) {
        finalHtml += emotes.parseThirdParty(message.substring(currentIndex, rep.start)) + rep.html;
        currentIndex = rep.end + 1;
    }
    finalHtml += emotes.parseThirdParty(message.substring(currentIndex));
    return finalHtml;
}

function connect(channel) {
    // Clear old emotes when switching channels
    emotes.clearEmotes();

    if (!channel) {
        hub.streams.twitch = '';
        if (twitchClient) {
            const old = twitchClient;
            twitchClient = null;
            old.removeAllListeners();
            old.disconnect().catch(() => {});
        }
        hub.setServiceStatus(KEY, { state: 'off', channel: '', detail: '' });
        return;
    }

    if (twitchClient && twitchClient.readyState() === 'OPEN') {
        const previous = hub.streams.twitch;
        twitchClient.part(previous).then(() => twitchClient.join(channel)).catch(() => twitchClient.join(channel));
        hub.streams.twitch = channel;
        hub.setServiceStatus(KEY, { state: 'connected', channel, detail: '' });
        return;
    }

    hub.streams.twitch = channel;
    hub.setServiceStatus(KEY, { state: 'connecting', channel, detail: 'Connecting to Twitch chat...' });
    const client = new tmi.Client({ channels: [channel] });
    twitchClient = client;

    client.on("roomstate", (_channel, state) => {
        if (state["room-id"] && !emotes.hasEmotes()) {
            emotes.loadExternalEmotes(state["room-id"]);
        }
    });

    client.on('connected', () => {
        if (client !== twitchClient) return;
        hub.setServiceStatus(KEY, { state: 'connected', channel: hub.streams.twitch, detail: '' });
        hub.announceConnected(KEY);
    });

    // tmi.js reconnects on its own; mirror that in the status.
    client.on('disconnected', (reason) => {
        if (client !== twitchClient) return;
        hub.setServiceStatus(KEY, { state: 'retrying', detail: `Disconnected: ${reason || 'unknown reason'}` });
    });
    client.on('reconnect', () => {
        if (client !== twitchClient) return;
        hub.setServiceStatus(KEY, { state: 'connecting', detail: 'Reconnecting to Twitch chat...' });
    });

    client.on('message', (_channel, tags, message) => {
        hub.handleIncomingMessage({
            platform: 'Twitch', author: escapeHtml(tags['display-name']),
            message: formatMessage(message, tags.emotes), color: tags['color'] || '#9146FF'
        });
    });

    // Activity Handlers
    const act = (type, text) => hub.handleActivity({ platform: 'Twitch', type, text });
    client.on("subscription", (_c, username) => act('sub', `${username} just subscribed!`));
    client.on("resub", (_c, username, months) => act('resub', `${username} resubscribed for ${months} months!`));
    client.on("subgift", (_c, username, _streak, recipient) => act('gift', `${username} gifted a sub to ${recipient}!`));
    client.on("cheer", (_c, userstate) => act('bits', `${userstate.username} cheered ${userstate.bits} bits!`));
    client.on("raided", (_c, username, viewers) => act('raid', `${username} is raiding with ${viewers} viewers!`));

    client.connect().catch((err) => {
        console.error(err);
        if (client !== twitchClient) return;
        hub.setServiceStatus(KEY, { state: 'error', detail: `Connection failed: ${err && err.message ? err.message : err}` });
    });
}

module.exports = { key: KEY, configKey: 'twitchChannel', normalize, connect };
