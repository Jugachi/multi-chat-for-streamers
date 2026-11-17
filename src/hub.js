// Shared state between the platform services and the socket.io clients:
// chat/activity history, which channels are active, and per-service status.

let io = null;

const MAX_HISTORY = 1000;
const MAX_ACTIVITY_HISTORY = 100;
const messageHistory = [];
const activityHistory = [];

// Currently active channel per service ('' = not configured).
const streams = { twitch: '', youtube: '', kick: '', tiktok: '' };

// Live connection state per service, pushed to every client so the UI can
// always show what we're connected to.
// state: 'off' | 'connecting' | 'connected' | 'retrying' | 'error'
const serviceStatus = {
    twitch: { name: 'Twitch', state: 'off', channel: '', virtual: false, detail: '' },
    youtube: { name: 'YouTube', state: 'off', channel: '', virtual: false, detail: '' },
    kick: { name: 'Kick', state: 'off', channel: '', virtual: false, detail: '' },
    tiktok: { name: 'TikTok', state: 'off', channel: '', virtual: false, detail: '' }
};

function attach(socketServer) {
    io = socketServer;
}

function emit(event, data) {
    if (io) io.emit(event, data);
}

// msgData: { platform, author (HTML-escaped), message (HTML), color (username color) }
function handleIncomingMessage(msgData) {
    messageHistory.push(msgData);
    if (messageHistory.length > MAX_HISTORY) messageHistory.shift();
    emit('chatMessage', msgData);
}

// data: { platform, type, text } — the client picks an SVG icon from `type`.
// Types: sub, resub, gift, bits, raid, host, follow
function handleActivity(data) {
    activityHistory.push(data);
    if (activityHistory.length > MAX_ACTIVITY_HISTORY) activityHistory.shift();
    emit('activityMessage', data);
}

function setServiceStatus(key, patch) {
    Object.assign(serviceStatus[key], patch);
    emit('serviceStatus', serviceStatus);
}

function connectedMessage(key) {
    const svc = serviceStatus[key];
    return { text: `Connected to ${svc.name}: ${svc.channel}`, platform: svc.name, id: key };
}

// Toast shown once per browser tab when a service connects.
function announceConnected(key) {
    emit('systemMessage', connectedMessage(key));
}

module.exports = {
    attach,
    streams,
    serviceStatus,
    messageHistory,
    activityHistory,
    handleIncomingMessage,
    handleActivity,
    setServiceStatus,
    connectedMessage,
    announceConnected
};
