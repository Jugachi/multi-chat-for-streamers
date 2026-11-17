// Theme editor page (/editor.html): controls -> generated CSS -> live preview,
// plus saving to custom-themes/ via the server (the chat hot-reloads it).
import { DEFAULTS, PRESETS, FONTS, generateCss, parseEditorSettings } from './theme-generator.js';
import { createMessageElement, applyMessageColors, themeWantsTypewriter, typewrite } from './messages.js';

const $ = (sel) => document.querySelector(sel);
const nameInput = $('#theme-name');
const loadSelect = $('#load-select');
const controls = $('#controls');
const cssOutput = $('#css-output');
const manualToggle = $('#manual-toggle');
const statusEl = $('#status');
const deleteBtn = $('#delete-btn');
const preview = $('#preview');

let settings = { ...DEFAULTS };
let manualCss = null;      // string while "edit by hand" is on
let editingId = null;      // id of the custom theme being edited (enables Delete)
let themes = [];

// ---------- Controls <-> settings ----------
for (const [value, label] of FONTS) $('#font-select').appendChild(new Option(label, value));

const inputs = [...document.querySelectorAll('[data-key]')];

function writeControls() {
    for (const input of inputs) {
        const value = settings[input.dataset.key];
        if (input.type === 'checkbox') input.checked = !!value;
        else input.value = value;
        const out = input.closest('label')?.querySelector('output');
        if (out) out.textContent = input.type === 'range' && input.dataset.key === 'bgOpacity' ? `${value}%` : `${value}px`;
    }
    updateConditionalFields();
}

function readControl(input) {
    const key = input.dataset.key;
    if (input.type === 'checkbox') settings[key] = input.checked;
    else if (input.type === 'range' || key === 'nameWeight') settings[key] = Number(input.value);
    else settings[key] = input.value;
}

// data-show-if="gradient" or data-show-if="borderMode=fixed"
function updateConditionalFields() {
    for (const el of document.querySelectorAll('[data-show-if]')) {
        const [key, expected] = el.dataset.showIf.split('=');
        el.hidden = expected === undefined ? !settings[key] : String(settings[key]) !== expected;
    }
}

for (const input of inputs) {
    input.addEventListener('input', () => {
        readControl(input);
        writeControls();
        refresh();
    });
}

// ---------- CSS output ----------
function currentCss() {
    return manualCss !== null ? manualCss : generateCss(settings);
}

function refresh() {
    if (manualCss === null) cssOutput.value = generateCss(settings);
    applyPreviewCss(currentCss());
}

manualToggle.addEventListener('change', () => {
    if (manualToggle.checked) {
        manualCss = cssOutput.value;
    } else {
        if (!confirm('Switch back to the visual controls? Your hand-made CSS changes will be lost.')) {
            manualToggle.checked = true;
            return;
        }
        manualCss = null;
    }
    setManualMode(manualCss !== null);
    refresh();
});

function setManualMode(on) {
    manualToggle.checked = on;
    cssOutput.readOnly = !on;
    controls.disabled = on;
    controls.classList.toggle('disabled', on);
    if (on) $('#advanced').open = true;
}

cssOutput.addEventListener('input', () => {
    if (manualCss === null) return;
    manualCss = cssOutput.value;
    applyPreviewCss(manualCss);
});

// ---------- Presets / loading ----------
document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
        const { name, ...preset } = PRESETS[btn.dataset.preset];
        settings = { ...DEFAULTS, ...preset };
        manualCss = null;
        setManualMode(false);
        editingId = null;
        deleteBtn.hidden = true;
        if (!nameInput.dataset.touched) nameInput.value = name;
        writeControls();
        refresh();
        replay();
    });
});
nameInput.addEventListener('input', () => { nameInput.dataset.touched = '1'; });

async function loadThemeList() {
    themes = await fetch('/api/themes').then(r => r.json());
    const keep = loadSelect.value;
    loadSelect.replaceChildren(new Option('— start fresh —', ''));
    for (const [label, list] of [['My Themes', themes.filter(t => t.custom)], ['Built-in (saved as a copy)', themes.filter(t => !t.custom)]]) {
        if (!list.length) continue;
        const group = document.createElement('optgroup');
        group.label = label;
        list.forEach(t => group.appendChild(new Option(t.name, t.id)));
        loadSelect.appendChild(group);
    }
    loadSelect.value = keep;
}

loadSelect.addEventListener('change', async () => {
    const theme = themes.find(t => t.id === loadSelect.value);
    let status = '';
    if (!theme) {
        settings = { ...DEFAULTS };
        manualCss = null;
        editingId = null;
    } else {
        const css = await fetch(`${theme.url}?v=${Date.now()}`).then(r => r.text());
        const editorSettings = parseEditorSettings(css);
        settings = editorSettings || { ...DEFAULTS };
        // Themes not made with the editor open as hand-editable CSS.
        manualCss = editorSettings ? null : css.replace(/^\s*\/\*\s*@name:.*?\*\/\s*/, '');
        editingId = theme.custom ? theme.id : null;
        nameInput.value = theme.custom ? theme.name : `${theme.name} (copy)`;
        nameInput.dataset.touched = '1';
        if (!editorSettings) status = 'This theme was written by hand, so it opens in the CSS editor below.';
        if (!theme.custom) status += ' Built-in themes are saved as a copy under My Themes.';
    }
    deleteBtn.hidden = !editingId;
    setManualMode(manualCss !== null);
    if (manualCss !== null) cssOutput.value = manualCss;
    writeControls();
    refresh();
    replay();
    setStatus(status.trim());
});

// ---------- Save / download / delete ----------
function setStatus(text, kind = '') {
    statusEl.textContent = text;
    statusEl.className = `status ${kind}`;
}

function slugify(name) {
    return String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'my-theme';
}

$('#save-btn').addEventListener('click', async () => {
    const name = nameInput.value.trim() || 'My Theme';
    const targetId = `custom-${slugify(name)}`;
    if (targetId !== editingId && themes.some(t => t.id === targetId)
        && !confirm(`A theme called "${name}" already exists. Overwrite it?`)) return;

    setStatus('Saving...');
    try {
        const res = await fetch('/api/themes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, css: currentCss() })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        editingId = data.id;
        deleteBtn.hidden = false;
        await loadThemeList();
        loadSelect.value = data.id;
        setStatus(`Saved "${data.name}". Pick it under Theme → My Themes in the chat settings (open chats update automatically).`, 'ok');
    } catch (err) {
        setStatus(`Could not save: ${err.message}`, 'error');
    }
});

$('#download-btn').addEventListener('click', () => {
    const name = nameInput.value.trim() || 'My Theme';
    const blob = new Blob([`/* @name: ${name.replace(/\*\//g, '')} */\n${currentCss()}`], { type: 'text/css' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slugify(name)}.css`;
    a.click();
    URL.revokeObjectURL(a.href);
});

deleteBtn.addEventListener('click', async () => {
    const theme = themes.find(t => t.id === editingId);
    if (!theme || !confirm(`Delete "${theme.name}"? Chats using it switch back to the default theme.`)) return;
    try {
        const res = await fetch(`/api/themes/${encodeURIComponent(theme.id)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        editingId = null;
        deleteBtn.hidden = true;
        loadSelect.value = '';
        await loadThemeList();
        setStatus(`Deleted "${theme.name}".`, 'ok');
    } catch (err) {
        setStatus(`Could not delete: ${err.message}`, 'error');
    }
});

// ---------- Live preview ----------
// An iframe keeps the theme's CSS (which styles `body`, `.message`, ...) away
// from the editor's own UI. Messages are rendered with the real chat code.
const SAMPLES = [
    { platform: 'Twitch', author: 'PixelPanda', message: 'LETS GOOO 🔥 that was clean', color: '#FF4500' },
    { platform: 'YouTube', author: 'Moonlit Mage', message: 'hello from Germany!', color: '#FF0000' },
    { platform: 'Kick', author: 'ChatGoblin', message: 'clip that, clip THAT', color: '#00FF7F' },
    { platform: 'TikTok', author: 'quesoqueen', message: 'first time catching this live 🙌', color: '#FF0050' },
    { platform: 'Twitch', author: 'lurker_larry', message: 'how long has the stream been going? I just got here and this is already peak content', color: '#1E90FF' },
    { platform: 'Twitch', author: 'NoScopeNancy', message: '@you GG, that boss fight was insane!', color: '#FF69B4', mention: true },
    { platform: 'YouTube', author: 'Toasted Toast', message: 'the music slaps', color: '#FF0000' },
    { platform: 'Kick', author: 'zerolatencyzane', message: 'W stream', color: '#FFD700' },
    { platform: 'TikTok', author: 'sleepy.otter', message: 'sending good vibes ✨', color: '#FF0050' },
    { platform: 'Twitch', author: 'GigaChad_Gaming', message: 'chat is this real', color: '#7B68EE' }
];

const BACKGROUNDS = {
    dark: '#0e0e10',
    game: 'linear-gradient(160deg, #6fa8d6 0%, #a9d0e8 35%, #5d8a4e 36%, #3f6b35 60%, #2c4a27 100%)',
    light: '#ececf1',
    checker: 'repeating-conic-gradient(#2a2a30 0% 25%, #1c1c21 0% 50%) 0 0 / 24px 24px'
};

let previewDoc = null;
let feedTimer = null;
let sampleIndex = 0;

function setupPreview() {
    preview.srcdoc = `<!DOCTYPE html><html><head>
        <link rel="stylesheet" href="/css/app.css">
        <style id="theme"></style>
        <style>html, body { height: 100%; } #chatbox { height: 100%; overflow: hidden; box-sizing: border-box; }</style>
        </head><body><div id="chatbox"></div></body></html>`;
    preview.addEventListener('load', () => {
        previewDoc = preview.contentDocument;
        setPreviewBackground('dark');
        refresh();
        replay();
    }, { once: true });
}

function applyPreviewCss(css) {
    if (!previewDoc) return;
    previewDoc.getElementById('theme').textContent = css;
}

function setPreviewBackground(key) {
    if (!previewDoc) return;
    previewDoc.documentElement.style.background = BACKGROUNDS[key];
    document.querySelectorAll('[data-bg]').forEach(b => b.classList.toggle('active', b.dataset.bg === key));
}

function scrollPreview() {
    const box = previewDoc && previewDoc.getElementById('chatbox');
    if (box) box.scrollTop = box.scrollHeight;
}

function addSample(animate) {
    const chatbox = previewDoc.getElementById('chatbox');
    const data = SAMPLES[sampleIndex++ % SAMPLES.length];
    const el = createMessageElement(data, { mention: !!data.mention, doc: previewDoc });
    if (!animate) el.style.animation = 'none';
    chatbox.appendChild(el);
    applyMessageColors(el, data);
    while (chatbox.children.length > 14) chatbox.firstChild.remove();
    scrollPreview();
    if (animate && themeWantsTypewriter(previewDoc)) typewrite(el.querySelector('.text'), scrollPreview);
}

function replay() {
    if (!previewDoc) return;
    clearInterval(feedTimer);
    previewDoc.getElementById('chatbox').replaceChildren();
    sampleIndex = 0;
    for (let i = 0; i < 4; i++) addSample(false);
    addSample(true);
    feedTimer = setInterval(() => addSample(true), 1800);
}

document.querySelectorAll('[data-bg]').forEach(b => b.addEventListener('click', () => setPreviewBackground(b.dataset.bg)));
$('#replay-btn').addEventListener('click', replay);

// ---------- Start ----------
writeControls();
cssOutput.value = generateCss(settings);
setupPreview();
loadThemeList().catch(() => setStatus('Could not load the theme list. Is Multi-Chat running?', 'error'));
