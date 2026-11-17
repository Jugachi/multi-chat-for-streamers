// Virtual / dev mode: fake chat and fake connections for testing.
// Nothing here opens a connection to Twitch, YouTube, Kick or TikTok, so it
// works on networks where those services are blocked.
const hub = require('./hub');
const emotes = require('./emotes');
const { escapeHtml } = require('./utils/html');

const FALLBACK_CHANNELS = { twitch: 'virtual-twitch', youtube: 'virtual-youtube', kick: 'virtual-kick', tiktok: 'virtual-tiktok' };

// Marks every service as virtually connected to the given channels.
function setStreams(streams) {
    for (const key of Object.keys(hub.serviceStatus)) {
        hub.streams[key] = streams[key] || '';
        hub.setServiceStatus(key, {
            state: 'connected', virtual: true, channel: hub.streams[key] || FALLBACK_CHANNELS[key],
            detail: `Simulated connection (no traffic to ${hub.serviceStatus[key].name})`
        });
    }
}

const usernames = [
    'PixelPanda', 'NoScopeNancy', 'ChatGoblin', 'xX_Speedrunner_Xx', 'CouchPotato99',
    'GigaChad_Gaming', 'lurker_larry', 'MoonlitMage', 'BasementDweller', 'QuesoQueen',
    'YeetMaster3000', 'SleepyOtter', 'CrtHum', 'FrostyMemes', 'ZeroLatencyZane',
    'WanderingWizard', 'ToastedToast', 'GlitchInTheMatrix', 'PogChampion', 'NoodleArms',
    'Sir_Loses_Alot', 'CaffeineOverdose', 'DankMemeDealer', 'ButtonMasher42', 'EmoteSpammer',
    'ShyViewer', 'LagSwitchLuke', 'RainbowRaptor', 'BoxOfFrogs', 'InfiniteRespawn'
];

// Viewers' own emojis stay as normal emojis in chat.
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

// YouTube and TikTok have no per-user name colors.
const fixedColors = { YouTube: '#FF0000', TikTok: '#FF0050' };

// Rough share of chat per platform
const platformWeights = [['Twitch', 0.45], ['YouTube', 0.2], ['Kick', 0.15], ['TikTok', 0.2]];

const randomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];
const months = () => 1 + Math.floor(Math.random() * 24);
const viewers = () => 1 + Math.floor(Math.random() * 200);

function randomPlatform() {
    let r = Math.random();
    for (const [name, weight] of platformWeights) {
        if ((r -= weight) < 0) return name;
    }
    return 'Twitch';
}

const activityGenerators = [
    () => ({ platform: 'Twitch', type: 'sub', text: `${randomItem(usernames)} just subscribed!` }),
    () => ({ platform: 'Twitch', type: 'resub', text: `${randomItem(usernames)} resubscribed for ${months()} months!` }),
    () => ({ platform: 'Twitch', type: 'gift', text: `${randomItem(usernames)} gifted a sub to ${randomItem(usernames)}!` }),
    () => ({ platform: 'Twitch', type: 'bits', text: `${randomItem(usernames)} cheered ${randomItem([100, 250, 500, 1000, 5000])} bits!` }),
    () => ({ platform: 'Twitch', type: 'raid', text: `${randomItem(usernames)} is raiding with ${viewers()} viewers!` }),
    () => ({ platform: 'Kick', type: 'sub', text: `${randomItem(usernames)} just subscribed!` }),
    () => ({ platform: 'Kick', type: 'gift', text: `${randomItem(usernames)} gifted ${randomItem([1, 5, 10])} subs!` }),
    () => ({ platform: 'Kick', type: 'host', text: `${randomItem(usernames)} is hosting with ${viewers()} viewers!` }),
    () => ({ platform: 'TikTok', type: 'gift', text: `${randomItem(usernames)} sent ${randomItem(['', '5x ', '10x '])}${randomItem(['Rose', 'TikTok', 'Finger Heart', 'Galaxy'])}!` }),
    () => ({ platform: 'TikTok', type: 'follow', text: `${randomItem(usernames)} followed!` })
];

function sendFakeMessage() {
    const platform = randomPlatform();
    hub.handleIncomingMessage({
        platform,
        author: escapeHtml(randomItem(usernames)),
        message: emotes.parseThirdParty(randomItem(messages)),
        color: fixedColors[platform] || randomItem(colors)
    });
    setTimeout(sendFakeMessage, 400 + Math.random() * 1600);
}

function sendFakeActivity() {
    hub.handleActivity(randomItem(activityGenerators)());
    setTimeout(sendFakeActivity, 4000 + Math.random() * 8000);
}

function start(initialStreams) {
    console.log('\n[virtual] Simulating Twitch/YouTube/Kick/TikTok connections and chat (no real connections)...\n');
    setStreams(initialStreams);
    sendFakeMessage();
    sendFakeActivity();
}

module.exports = { start, setStreams };
