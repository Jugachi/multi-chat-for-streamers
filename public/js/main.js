// Client entry point (ES module). Message rendering lives in messages.js, icons in icons.js.
import { icons, brandColors, uiIcons } from './icons.js';
import { createMessageElement, applyMessageColors, themeWantsTypewriter, typewrite } from './messages.js';
import { createSocket } from './socket.js';

const socket = createSocket();
const chatbox = document.getElementById('chatbox');
const settingsMenu = document.getElementById('settings-menu');
const modeSelect = document.getElementById('mode-select');
const themeSelect = document.getElementById('theme-select');
const bgSelect = document.getElementById('bg-select');
const themeLink = document.getElementById('theme-link');
const scrollBtn = document.getElementById('scroll-btn');
const mentionSelect = document.getElementById('mention-select');
const urlParams = new URLSearchParams(window.location.search);
const overrideMode = urlParams.get('mode');
const overrideBg = urlParams.get('bg');
const overrideTheme = urlParams.get('theme');
const posSelect = document.getElementById('pos-select');

// Desktop app window (loaded with ?app=1): open the theme editor in the same
// window instead of a new one; the editor has a "Back to chat" link.
if (urlParams.has('app')) sessionStorage.setItem('desktopApp', '1');
if (sessionStorage.getItem('desktopApp')) {
    document.querySelectorAll('.editor-link').forEach(a => a.removeAttribute('target'));
}

// Setup Elements
const setupModal = document.getElementById('setup-modal');
const setupTwitch = document.getElementById('setup-twitch');
const setupYoutube = document.getElementById('setup-youtube');
const setupKick = document.getElementById('setup-kick');
const setupTiktok = document.getElementById('setup-tiktok');
const setupBtn = document.getElementById('setup-btn');
const menuTwitch = document.getElementById('menu-twitch');
const menuYoutube = document.getElementById('menu-youtube');
const menuKick = document.getElementById('menu-kick');
const menuTiktok = document.getElementById('menu-tiktok');
const menuConnectBtn = document.getElementById('menu-connect-btn');

let currentMode = 'widget';
let isUserScrolledUp = false;
let streamerName = "";
let highlightMentions = true;

// --- Collapsible settings sections ---
// Remembers which sections are open per browser (falls back to the HTML defaults).
const SECTIONS_KEY = 'settingsSectionsOpen';
let savedSections = {};
try { savedSections = JSON.parse(localStorage.getItem(SECTIONS_KEY)) || {}; } catch (e) { /* ignore bad data */ }
document.querySelectorAll('.settings-section').forEach((section) => {
    const key = section.dataset.section;
    if (key in savedSections) section.open = savedSections[key];
    section.addEventListener('toggle', () => {
        savedSections[key] = section.open;
        localStorage.setItem(SECTIONS_KEY, JSON.stringify(savedSections));
    });
});

// --- Connection Status Bar ---
// Shows only the icons of services that are currently connected.
const statusBar = document.getElementById('status-live');
document.getElementById('settings-btn').addEventListener('click', () => {
    settingsMenu.style.display = (settingsMenu.style.display === 'block') ? 'none' : 'block';
});
let lastServiceStatus = null;
let appServerOnline = false;

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderStatusBar() {
    // Service state is stale while the local server is unreachable, so show nothing.
    if (!appServerOnline || !lastServiceStatus) {
        statusBar.innerHTML = '';
        return;
    }
    const connected = Object.values(lastServiceStatus).filter(svc => svc.state === 'connected');
    if (connected.length === 0) {
        statusBar.innerHTML = '';
        return;
    }
    statusBar.innerHTML = '<span class="status-label">Live on:</span>' + connected
        .map(svc => {
            const tooltip = [svc.name, svc.channel, svc.virtual ? 'virtual' : ''].filter(Boolean).join(' — ');
            return `<span class="status-icon" style="color:${brandColors[svc.name] || 'inherit'}" title="${escapeHtml(tooltip)}">${icons[svc.name] || ''}</span>`;
        })
        .join('');
}

socket.on('serviceStatus', (status) => {
    lastServiceStatus = status;
    renderStatusBar();
});
socket.on('connect', () => { appServerOnline = true; renderStatusBar(); });
socket.on('disconnect', () => { appServerOnline = false; renderStatusBar(); });
renderStatusBar();

// Toast System Message
socket.on('systemMessage', (data) => {
    // Check session storage so we only show the popup ONCE per tab session
    if (sessionStorage.getItem('notified_' + data.id)) return;
    sessionStorage.setItem('notified_' + data.id, 'true');

    // data: { text, platform, id } — platform is a brand name or 'virtual'
    const color = brandColors[data.platform] || '#9146FF';
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.style.borderBottom = `3px solid ${color}`;
    toast.innerHTML = data.platform === 'virtual' ? uiIcons.virtual : uiIcons.check;
    toast.firstElementChild.style.color = color;
    const text = document.createElement('span');
    text.textContent = data.text;
    toast.appendChild(text);

    document.getElementById('toast-container').appendChild(toast);

    // Remove from DOM after animation ends (5s total)
    setTimeout(() => toast.remove(), 5000);
});

// Keeps the newest message in view unless the user scrolled up to read.
function keepScrolledToBottom() {
    if (!isUserScrolledUp || currentMode === 'widget') {
        chatbox.scrollTop = chatbox.scrollHeight;
        return true;
    }
    return false;
}

// live = false for history replays (those appear instantly, no typewriter)
// --- Themes (built-in + custom, hot reloaded) ---
// The list comes from the server (/api/themes); 'themesChanged' fires whenever a
// theme file is added, edited or removed, and we re-fetch the active stylesheet.
let availableThemes = [];
let activeThemeId = 'dark-pill';
let themeVersion = Date.now();

function themeUrl(id) {
    const theme = availableThemes.find(t => t.id === id);
    return `${theme ? theme.url : `/themes/${encodeURIComponent(id)}.css`}?v=${themeVersion}`;
}

function applyTheme(id) {
    activeThemeId = id || 'dark-pill';
    themeLink.href = themeUrl(activeThemeId);
    themeSelect.value = activeThemeId;
}

function renderThemeOptions() {
    const groups = [['Built-in', availableThemes.filter(t => !t.custom)], ['My Themes', availableThemes.filter(t => t.custom)]];
    themeSelect.replaceChildren();
    for (const [label, list] of groups) {
        if (!list.length) continue;
        const group = document.createElement('optgroup');
        group.label = label;
        for (const t of list) group.appendChild(new Option(t.name, t.id));
        themeSelect.appendChild(group);
    }
    themeSelect.value = activeThemeId;
}

fetch('/api/themes').then(r => r.json()).then((list) => {
    availableThemes = list;
    renderThemeOptions();
    applyTheme(activeThemeId); // custom themes need their real URL
}).catch(() => { /* keep the current stylesheet */ });

socket.on('themesChanged', ({ themes, version }) => {
    availableThemes = themes;
    themeVersion = version;
    // Active theme file was deleted: fall back to the default instead of no styling.
    if (!themes.some(t => t.id === activeThemeId)) activeThemeId = 'dark-pill';
    renderThemeOptions();
    applyTheme(activeThemeId);
});

function appendMessage(data, live = true) {
    // Check if mentions are enabled AND the message contains your name
    const mention = highlightMentions && !!streamerName && data.message.toLowerCase().includes(streamerName.toLowerCase());
    const msgElement = createMessageElement(data, { mention });
    chatbox.appendChild(msgElement);
    applyMessageColors(msgElement, data);

    const maxAllowed = (currentMode === 'widget') ? 50 : 1000;
    while (chatbox.children.length > maxAllowed) {
        chatbox.removeChild(chatbox.firstChild);
    }

    if (!keepScrolledToBottom()) {
        scrollBtn.style.display = 'block';
    }

    if (live && themeWantsTypewriter()) {
        const textEl = msgElement.querySelector('.text');
        if (textEl) typewrite(textEl, keepScrolledToBottom);
    }
}

socket.on('loadConfig', (config) => {
    // Apply URL overrides first so we know the true state
    currentMode = overrideMode || config.mode || 'widget';

    if (config.needsSetup && overrideMode !== 'widget') {
        setupModal.style.display = 'flex';
    } else {
        setupModal.style.display = 'none';
    }

    // Only stream-related payloads carry these fields; settings-only updates don't.
    if ('activeTwitch' in config) {
        menuTwitch.value = config.activeTwitch || '';
        menuYoutube.value = config.activeYouTube || '';
        menuKick.value = config.activeKick || '';
        menuTiktok.value = config.activeTikTok || '';
    }

    // Apply Mode Settings
    document.body.className = `mode-${currentMode}`;
    modeSelect.value = currentMode;
    if (currentMode === 'widget') scrollBtn.style.display = 'none';

    // Apply Theme Settings
    applyTheme(overrideTheme || config.theme);

    // Apply Background Settings
    const activeBg = overrideBg || config.background;
    document.body.style.background = activeBg === 'dark' ? '#0e0e10' : 'transparent';
    bgSelect.value = activeBg;

    // Apply Mentions Settings
    streamerName = config.streamerName || "";
    highlightMentions = config.mentions !== false;
    mentionSelect.value = highlightMentions.toString();

    // Apply Activity Position Settings
    const activePos = urlParams.get('pos') || config.activityPos || 'right';
    if (activePos === 'left') document.body.classList.add('activity-left');
    else document.body.classList.remove('activity-left');
    if (posSelect) posSelect.value = activePos;
});

// Load complete server-side history cache upon opening/refreshing tab
socket.on('chatHistory', (history) => {
    chatbox.innerHTML = '';
    history.forEach(msg => appendMessage(msg, false));
    window.scrollTo(0, document.body.scrollHeight);
});

socket.on('chatMessage', (data) => {
    appendMessage(data);
});

modeSelect.addEventListener('change', (e) => socket.emit('updateConfig', { mode: e.target.value }));
themeSelect.addEventListener('change', (e) => socket.emit('updateConfig', { theme: e.target.value }));
bgSelect.addEventListener('change', (e) => socket.emit('updateConfig', { background: e.target.value }));
mentionSelect.addEventListener('change', (e) => socket.emit('updateConfig', { mentions: e.target.value === 'true' }));

// Detect manual scrolling up
chatbox.addEventListener('scroll', () => {
    if (currentMode === 'widget') return; // Ignore manual scroll tracking in widget mode

    // Calculate how far the user is from the bottom of the chatbox
    const distanceToBottom = chatbox.scrollHeight - chatbox.clientHeight - chatbox.scrollTop;
    isUserScrolledUp = distanceToBottom > 80;

    if (!isUserScrolledUp) {
        scrollBtn.style.display = 'none';
    }
});

// Click handler for the floating snap-to-bottom button
scrollBtn.addEventListener('click', () => {
    chatbox.scrollTop = chatbox.scrollHeight;
    scrollBtn.style.display = 'none';
    isUserScrolledUp = false;
});

// Toggle configuration menu with 'T' key, and position with L/R
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    const key = e.key.toLowerCase();

    if (key === 't') {
        settingsMenu.style.display = (settingsMenu.style.display === 'block') ? 'none' : 'block';
    }

    if (currentMode === 'streamer') {
        if (key === 'l') socket.emit('updateConfig', { activityPos: 'left' });
        if (key === 'r') socket.emit('updateConfig', { activityPos: 'right' });
    }
});

const activityList = document.getElementById('activity-list');

function appendActivity(data) {
    // data: { platform, type, text } — type picks the icon (sub, gift, bits, ...)
    const div = document.createElement('div');
    div.className = 'activity-item';
    div.style.setProperty('--platform-color', brandColors[data.platform] || '#9146FF');

    const icon = document.createElement('div');
    icon.className = 'activity-icon';
    icon.innerHTML = (uiIcons[data.type] || uiIcons.sub)
        + (icons[data.platform] ? `<span class="activity-platform">${icons[data.platform]}</span>` : '');

    const text = document.createElement('span');
    text.textContent = data.text;

    div.append(icon, text);
    activityList.prepend(div); // Add to the TOP of the list

    // Keep maximum 100 activities in the DOM
    while (activityList.children.length > 100) {
        activityList.removeChild(activityList.lastChild);
    }
}

socket.on('activityMessage', (data) => {
    appendActivity(data);
});

socket.on('activityHistory', (history) => {
    activityList.innerHTML = '';
    // Reverse so newest is on top when appending
    [...history].reverse().forEach(data => appendActivity(data));
});

// Detect manual scrolling up on the Window (Chat Mode)
window.addEventListener('scroll', () => {
    if (currentMode !== 'chat') return;
    const distanceToBottom = document.body.scrollHeight - window.innerHeight - window.scrollY;
    isUserScrolledUp = distanceToBottom > 80;
    if (!isUserScrolledUp) scrollBtn.style.display = 'none';
});

// Detect manual scrolling up on the Chatbox (Streamer Mode)
chatbox.addEventListener('scroll', () => {
    if (currentMode !== 'streamer') return;
    const distanceToBottom = chatbox.scrollHeight - chatbox.clientHeight - chatbox.scrollTop;
    isUserScrolledUp = distanceToBottom > 80;
    if (!isUserScrolledUp) scrollBtn.style.display = 'none';
});

// Click handler for the floating snap-to-bottom button
scrollBtn.addEventListener('click', () => {
    if (currentMode === 'streamer') chatbox.scrollTop = chatbox.scrollHeight;
    else window.scrollTo(0, document.body.scrollHeight);

    scrollBtn.style.display = 'none';
    isUserScrolledUp = false;
});

// Event Listener for the Position Dropdown
if (posSelect) {
    posSelect.addEventListener('change', (e) => socket.emit('updateConfig', { activityPos: e.target.value }));
}

// Handle Setup Modal Submit
const readStreams = (twitch, youtube, kick, tiktok) => ({
    twitch: twitch.value.trim(),
    youtube: youtube.value.trim(),
    kick: kick.value.trim(),
    tiktok: tiktok.value.trim()
});

setupBtn.addEventListener('click', () => {
    const streams = readStreams(setupTwitch, setupYoutube, setupKick, setupTiktok);
    if (!Object.values(streams).some(Boolean)) return alert("Please enter at least one channel!");
    socket.emit('updateStreams', streams);
    setupModal.style.display = 'none';
});

// Handle Settings Menu Stream Switch Submit
menuConnectBtn.addEventListener('click', () => {
    const streams = readStreams(menuTwitch, menuYoutube, menuKick, menuTiktok);

    // Allow the "Connected to ..." toast to show again for the new channels
    for (const key of Object.keys(streams)) sessionStorage.removeItem('notified_' + key);
    socket.emit('updateStreams', streams);
    menuConnectBtn.innerText = "Connecting...";
    setTimeout(() => menuConnectBtn.innerText = "Switch Streams", 1500);
});

