// Third-party Twitch emotes (7TV, BTTV, FFZ). Also applied to other platforms'
// chat, since viewers often type the same emote codes there.
const { escapeHtml } = require('./utils/html');

const thirdPartyEmotes = {};

function clearEmotes() {
    for (const key in thirdPartyEmotes) delete thirdPartyEmotes[key];
}

function hasEmotes() {
    return Object.keys(thirdPartyEmotes).length > 0;
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

// Turns plain chat text into safe HTML, swapping emote codes for images.
function parseThirdParty(text) {
    return String(text || '').split(' ').map(word => {
        if (Object.prototype.hasOwnProperty.call(thirdPartyEmotes, word)) {
            return `<img src="${thirdPartyEmotes[word]}" class="emote" alt="${escapeHtml(word)}">`;
        }
        return escapeHtml(word);
    }).join(' ');
}

module.exports = { clearEmotes, hasEmotes, loadExternalEmotes, parseThirdParty };
