const { LiveChat } = require('youtube-chat');
const hub = require('../hub');
const emotes = require('../emotes');
const { escapeHtml } = require('../utils/html');

const KEY = 'youtube';
const RETRY_MS = 60000;
let ytChat = null;
let retryTimeout;

const isChannelId = (s) => s.startsWith('UC') && s.length === 24;

// Accepts a channel ID (UC...), a video ID, or a watch / youtu.be URL.
function normalize(input) {
    const s = String(input || '').trim();
    if (!s || isChannelId(s)) return s;
    const match = s.match(/(?:v=|youtu\.be\/)([^&?]+)/);
    return match ? match[1] : s;
}

function connect(input) {
    if (ytChat) {
        ytChat.stop();
        ytChat.removeAllListeners();
    }
    clearTimeout(retryTimeout);
    if (!input) {
        hub.streams.youtube = '';
        ytChat = null;
        hub.setServiceStatus(KEY, { state: 'off', channel: '', detail: '' });
        return;
    }

    hub.streams.youtube = input;
    hub.setServiceStatus(KEY, { state: 'connecting', channel: input, detail: 'Connecting to YouTube live chat...' });

    const id = normalize(input);
    ytChat = new LiveChat(isChannelId(id) ? { channelId: id } : { liveId: id });

    const retryLater = (detail) => {
        hub.setServiceStatus(KEY, { state: 'retrying', detail: `${detail} Retrying in ${RETRY_MS / 1000}s...` });
        retryTimeout = setTimeout(() => connect(hub.streams.youtube), RETRY_MS);
    };

    ytChat.on('start', () => {
        hub.setServiceStatus(KEY, { state: 'connected', detail: '' });
        hub.announceConnected(KEY);
    });

    ytChat.on('chat', (chatItem) => {
        let finalHtml = "";
        chatItem.message.forEach(m => {
            if (m.url) finalHtml += `<img src="${escapeHtml(m.url)}" class="emote"> `;
            else if (m.text) finalHtml += emotes.parseThirdParty(m.text) + " ";
        });
        hub.handleIncomingMessage({ platform: 'YouTube', author: escapeHtml(chatItem.author.name), message: finalHtml.trim(), color: '#FF0000' });
    });

    ytChat.on('end', (reason) => {
        hub.setServiceStatus(KEY, { state: 'error', detail: `Live chat ended${reason ? `: ${reason}` : ''}` });
    });

    ytChat.on('error', () => {
        console.log("YouTube chat dropped. Retrying in 60s...");
        if (ytChat) ytChat.stop();
        retryLater('Chat dropped.');
    });

    ytChat.start().catch(() => {
        console.log("YouTube not live. Retrying in 60s...");
        retryLater('Not live (or unreachable).');
    });
}

module.exports = { key: KEY, configKey: 'youtubeChannel', normalize, connect };
