// Kick has no official chat library; its web player reads chat from a public
// Pusher websocket. We look up the channel's chatroom id once, then subscribe.
const hub = require('../hub');
const emotes = require('../emotes');
const { escapeHtml } = require('../utils/html');

const KEY = 'kick';
const PUSHER_URL = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';
const RETRY_MS = 30000;
let kickSocket = null;
let retryTimeout;

// Accepts "name", "@name" or a kick.com URL.
function normalize(input) {
    let s = String(input || '').trim();
    const url = s.match(/kick\.com\/@?([^/?#]+)/i);
    if (url) s = url[1];
    return s.replace(/^@/, '').toLowerCase();
}

async function fetchChatroomId(slug) {
    const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!res.ok) throw new Error(`Kick API returned HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.chatroom || !data.chatroom.id) throw new Error('Channel not found');
    return data.chatroom.id;
}

// Kick emotes arrive inline as [emote:12345:NAME]
function formatMessage(content) {
    return String(content || '').split(/(\[emote:\d+:[^\]]*\])/g).map(part => {
        const m = part.match(/^\[emote:(\d+):([^\]]*)\]$/);
        if (m) return `<img src="https://files.kick.com/emotes/${m[1]}/fullsize" class="emote" alt="${escapeHtml(m[2])}">`;
        return emotes.parseThirdParty(part);
    }).join('');
}

function stop() {
    clearTimeout(retryTimeout);
    if (kickSocket) {
        const old = kickSocket;
        kickSocket = null;
        old.onopen = old.onmessage = old.onclose = old.onerror = null;
        try { old.close(); } catch (e) { /* already closed */ }
    }
}

async function connect(channel) {
    stop();
    hub.streams.kick = channel || '';
    if (!channel) {
        hub.setServiceStatus(KEY, { state: 'off', channel: '', detail: '' });
        return;
    }

    hub.setServiceStatus(KEY, { state: 'connecting', channel, detail: 'Looking up Kick channel...' });
    const retry = (detail) => {
        if (hub.streams.kick !== channel) return;
        hub.setServiceStatus(KEY, { state: 'retrying', detail: `${detail} Retrying in ${RETRY_MS / 1000}s...` });
        clearTimeout(retryTimeout);
        retryTimeout = setTimeout(() => connect(channel), RETRY_MS);
    };

    let chatroomId;
    try {
        chatroomId = await fetchChatroomId(channel);
    } catch (err) {
        console.log(`Kick lookup failed for "${channel}": ${err.message}`);
        return retry(`Lookup failed (${err.message}).`);
    }
    if (hub.streams.kick !== channel) return; // switched channels while we were waiting

    const ws = new WebSocket(PUSHER_URL);
    kickSocket = ws;
    const act = (type, text) => hub.handleActivity({ platform: 'Kick', type, text });

    ws.onmessage = (event) => {
        let packet;
        try { packet = JSON.parse(event.data); } catch (e) { return; }
        // Pusher double-encodes event payloads as a JSON string.
        let data = packet.data;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { /* keep string */ } }

        switch (packet.event) {
            case 'pusher:connection_established':
                ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${chatroomId}.v2` } }));
                break;
            case 'pusher_internal:subscription_succeeded':
                hub.setServiceStatus(KEY, { state: 'connected', detail: '' });
                hub.announceConnected(KEY);
                break;
            case 'pusher:ping':
                ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
                break;
            case 'pusher:error':
                console.log('Kick chat error:', data);
                break;
            case 'App\\Events\\ChatMessageEvent':
                hub.handleIncomingMessage({
                    platform: 'Kick',
                    author: escapeHtml(data.sender && data.sender.username),
                    message: formatMessage(data.content),
                    color: (data.sender && data.sender.identity && data.sender.identity.color) || '#53FC18'
                });
                break;
            case 'App\\Events\\SubscriptionEvent':
                if (data.months > 1) act('resub', `${data.username} resubscribed for ${data.months} months!`);
                else act('sub', `${data.username} just subscribed!`);
                break;
            case 'App\\Events\\GiftedSubscriptionsEvent': {
                const count = (data.gifted_usernames || []).length || 1;
                act('gift', `${data.gifter_username} gifted ${count} sub${count === 1 ? '' : 's'}!`);
                break;
            }
            case 'App\\Events\\StreamHostEvent':
                act('host', `${data.host_username} is hosting with ${data.number_viewers} viewers!`);
                break;
        }
    };

    ws.onclose = () => retry('Chat connection closed.');
    ws.onerror = () => { /* onclose follows and handles the retry */ };
}

module.exports = { key: KEY, configKey: 'kickChannel', normalize, connect };
