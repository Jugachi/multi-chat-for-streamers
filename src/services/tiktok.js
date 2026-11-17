// Uses tiktok-live-connector, which signs requests through its third-party
// sign server (Euler Stream). The streamer must be live for connect() to succeed.
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');
const hub = require('../hub');
const emotes = require('../emotes');
const { escapeHtml } = require('../utils/html');

const KEY = 'tiktok';
const RETRY_MS = 60000;
let tiktokConn = null;
let retryTimeout;

// Accepts "name", "@name" or a tiktok.com URL.
function normalize(input) {
    let s = String(input || '').trim();
    const url = s.match(/tiktok\.com\/@?([^/?#]+)/i);
    if (url) s = url[1];
    return s.replace(/^@/, '');
}

function stop() {
    clearTimeout(retryTimeout);
    if (tiktokConn) {
        const old = tiktokConn;
        tiktokConn = null;
        old.removeAllListeners();
        old.disconnect().catch(() => {});
    }
}

function connect(username) {
    stop();
    hub.streams.tiktok = username || '';
    if (!username) {
        hub.setServiceStatus(KEY, { state: 'off', channel: '', detail: '' });
        return;
    }

    hub.setServiceStatus(KEY, { state: 'connecting', channel: username, detail: 'Connecting to TikTok LIVE...' });
    const conn = new TikTokLiveConnection(username);
    tiktokConn = conn;

    const retry = (detail) => {
        if (conn !== tiktokConn) return;
        hub.setServiceStatus(KEY, { state: 'retrying', detail: `${detail} Retrying in ${RETRY_MS / 1000}s...` });
        clearTimeout(retryTimeout);
        retryTimeout = setTimeout(() => connect(username), RETRY_MS);
    };
    const displayName = (user) => (user && (user.nickname || user.uniqueId)) || 'Someone';
    const act = (type, text) => hub.handleActivity({ platform: 'TikTok', type, text });

    conn.on(WebcastEvent.CHAT, (data) => {
        hub.handleIncomingMessage({
            platform: 'TikTok',
            author: escapeHtml(displayName(data.user)),
            message: emotes.parseThirdParty(data.comment || ''),
            color: '#FF0050'
        });
    });

    conn.on(WebcastEvent.GIFT, (data) => {
        const giftType = data.giftDetails && data.giftDetails.giftType;
        // Streakable gifts fire repeatedly while the streak runs; only report the final count.
        if (giftType === 1 && !data.repeatEnd) return;
        const giftName = (data.giftDetails && data.giftDetails.giftName) || 'a gift';
        const count = data.repeatCount > 1 ? `${data.repeatCount}x ` : '';
        act('gift', `${displayName(data.user)} sent ${count}${giftName}!`);
    });

    conn.on(WebcastEvent.FOLLOW, (data) => act('follow', `${displayName(data.user)} followed!`));

    conn.on(ControlEvent.DISCONNECTED, () => retry('Disconnected.'));
    conn.on(ControlEvent.ERROR, ({ info }) => console.log('TikTok error:', info));

    conn.connect().then(() => {
        if (conn !== tiktokConn) return;
        hub.setServiceStatus(KEY, { state: 'connected', detail: '' });
        hub.announceConnected(KEY);
    }).catch((err) => {
        console.log(`TikTok connect failed for "${username}": ${err && err.message ? err.message : err}`);
        retry(err && err.constructor && err.constructor.name === 'UserOfflineError' ? 'Not live.' : 'Connection failed.');
    });
}

module.exports = { key: KEY, configKey: 'tiktokUsername', normalize, connect };
