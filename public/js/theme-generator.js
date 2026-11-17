// Turns theme-editor settings into a theme stylesheet. The settings are stored
// as JSON inside the CSS (`/* @editor: {...} */`) so a saved theme can be
// reopened in the editor later.

export const FONTS = [
    ["'Segoe UI', sans-serif", 'Segoe UI'],
    ["'Trebuchet MS', 'Segoe UI', sans-serif", 'Trebuchet'],
    ["'Bahnschrift', 'Segoe UI', sans-serif", 'Bahnschrift (techy)'],
    ["'Arial Rounded MT Bold', 'Segoe UI', sans-serif", 'Rounded'],
    ["Georgia, serif", 'Georgia (serif)'],
    ["'Palatino Linotype', 'Book Antiqua', serif", 'Palatino (fantasy)'],
    ["'Consolas', 'Courier New', monospace", 'Consolas (retro)'],
    ["'Comic Sans MS', 'Segoe UI', sans-serif", 'Comic Sans (fun)'],
    ["Impact, 'Arial Black', sans-serif", 'Impact (bold)']
];

export const DEFAULTS = {
    layout: 'bubble',          // bubble | line | tag | pills | header
    font: FONTS[0][0],
    fontSize: 16,
    textColor: '#f4f4f5',
    textOutline: false,

    bgColor: '#141419',
    bgOpacity: 85,
    gradient: false,
    bgColor2: '#2a1a3f',
    radius: 12,
    padding: 10,
    spacing: 8,

    borderWidth: 0,
    borderMode: 'fixed',       // fixed | user | platform
    borderColor: '#9146ff',
    glow: 0,
    glowMode: 'user',
    glowColor: '#9146ff',

    nameColorMode: 'user',     // user | fixed | platform
    nameColor: '#ffffff',
    nameWeight: 700,
    nameUppercase: false,
    nameBrackets: false,
    showColon: true,
    iconMode: 'logo',          // logo | text | hidden
    iconSize: 18,

    animation: 'slide',        // none | fade | slide | pop | bounce | flicker
    typewriter: false,
    mentionColor: '#ffd700'
};

export const PRESETS = {
    clean: { name: 'Clean Pill' },
    mmo: {
        name: 'MMO Log', layout: 'line', font: FONTS[1][0], fontSize: 17, textColor: '#ffe9b0',
        textOutline: true, bgOpacity: 0, padding: 2, nameBrackets: true, iconMode: 'text', animation: 'fade', spacing: 2
    },
    neon: {
        name: 'Neon Glow', layout: 'tag', bgColor: '#0a0a12', bgOpacity: 88, radius: 10, borderWidth: 2,
        borderMode: 'user', glow: 10, glowMode: 'user', animation: 'flicker', spacing: 22, showColon: false
    },
    cute: {
        name: 'Cute Bubble', layout: 'pills', font: FONTS[3][0], bgColor: '#fffaf0', bgOpacity: 100,
        textColor: '#4a3428', borderWidth: 3, borderMode: 'fixed', borderColor: '#4a3428', radius: 16,
        nameColorMode: 'fixed', nameColor: '#4a3428', showColon: false, animation: 'pop', spacing: 14
    },
    hud: {
        name: 'Game HUD', layout: 'header', font: FONTS[2][0], bgColor: '#0a1638', gradient: true,
        bgColor2: '#1e0c42', bgOpacity: 92, radius: 0, nameUppercase: true, showColon: false, animation: 'slide'
    },
    rpg: {
        name: 'RPG Box', layout: 'tag', font: FONTS[6][0], fontSize: 17, bgColor: '#2a3fb8', gradient: true,
        bgColor2: '#0f1858', bgOpacity: 100, borderWidth: 3, borderMode: 'fixed', borderColor: '#ffffff',
        radius: 6, nameUppercase: true, showColon: false, typewriter: true, animation: 'pop', spacing: 22
    }
};

const ANIMATIONS = {
    none: null,
    fade: ['0.3s ease-out', 'from { opacity: 0; } to { opacity: 1; }'],
    slide: ['0.3s ease-out', 'from { opacity: 0; transform: translateX(-16px); } to { opacity: 1; transform: translateX(0); }'],
    pop: ['0.35s cubic-bezier(0.34, 1.56, 0.64, 1)', 'from { opacity: 0; transform: scale(0.7); } to { opacity: 1; transform: scale(1); }'],
    bounce: ['0.5s ease-out', '0% { opacity: 0; transform: translateY(18px); } 60% { opacity: 1; transform: translateY(-4px); } 100% { transform: translateY(0); }'],
    flicker: ['0.5s ease-out', '0% { opacity: 0; } 30% { opacity: 1; } 40% { opacity: 0.3; } 55% { opacity: 1; } 65% { opacity: 0.6; } 100% { opacity: 1; }']
};

const PLATFORMS = ['Twitch', 'YouTube', 'Kick', 'TikTok'];

function rgba(hex, alpha) {
    const n = parseInt(String(hex).replace('#', ''), 16) || 0;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.round(alpha * 100) / 100})`;
}

function colorFor(mode, fixed) {
    if (mode === 'user') return 'var(--user-color)';
    if (mode === 'platform') return 'var(--platform-color)';
    return fixed;
}

export function generateCss(settings) {
    const s = { ...DEFAULTS, ...settings };
    const alpha = s.bgOpacity / 100;
    const bg = s.gradient
        ? `linear-gradient(135deg, ${rgba(s.bgColor, alpha)}, ${rgba(s.bgColor2, alpha)})`
        : rgba(s.bgColor, alpha);
    const solidBg = rgba(s.bgColor, Math.max(alpha, 0.9));
    const border = s.borderWidth > 0 ? `${s.borderWidth}px solid ${colorFor(s.borderMode, s.borderColor)}` : 'none';
    const glow = s.glow > 0 ? `0 0 ${s.glow}px ${colorFor(s.glowMode, s.glowColor)}` : 'none';
    const pad = `${s.padding}px ${s.padding + 4}px`;
    const anim = ANIMATIONS[s.animation];
    // In "pills" the bubble is the .text; in every other layout it's the whole .message.
    const box = s.layout === 'pills' ? '.message .text' : '.message';

    const css = [];
    const rule = (selector, body) => css.push(`${selector} {\n${body.filter(Boolean).map(l => `    ${l}`).join('\n')}\n}`);

    rule('body', [
        s.typewriter && '--typewriter: 1;',
        `font-family: ${s.font};`,
        `font-size: ${s.fontSize}px;`,
        `color: ${s.textColor};`,
        'background: transparent;',
        `margin: 0; padding: ${['tag', 'pills'].includes(s.layout) ? 16 : 10}px 10px 10px; overflow: hidden;`,
        s.textOutline && 'text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 0 0 4px rgba(0, 0, 0, 0.8);'
    ]);

    rule('.message', [
        `margin: 0 4px ${s.spacing}px;`,
        'word-break: break-word;',
        anim && `animation: themeIn ${anim[0]};`,
        s.layout === 'pills' && 'transform-origin: left bottom;'
    ]);

    // Box look (background, border, glow, corners)
    rule(box, [
        `background: ${bg};`,
        `border: ${border};`,
        `border-radius: ${s.radius}px;`,
        `box-shadow: ${glow};`,
        s.layout !== 'header' && `padding: ${pad};`
    ]);

    // Layout
    switch (s.layout) {
        case 'bubble':
            rule('.message', ['display: flex;', 'align-items: center;', 'gap: 8px;']);
            break;
        case 'line':
            rule('.message', ['display: block;', 'line-height: 1.4;']);
            rule('.platform-icon', ['display: inline-block;', 'vertical-align: middle;', 'margin-right: 6px;']);
            break;
        case 'tag':
            rule('.message', ['position: relative;', `margin-top: ${Math.round(s.fontSize * 0.9)}px;`, `padding-top: ${s.padding + 8}px;`]);
            rule('.author', [
                'position: absolute;', 'top: -0.85em;', 'left: 12px;', 'padding: 1px 10px;', 'font-size: 0.8em;', 'line-height: 1.5;',
                `background: ${solidBg};`,
                `border: ${border === 'none' ? '1px solid rgba(255, 255, 255, 0.25)' : border};`,
                `border-radius: ${Math.min(s.radius, 10)}px;`,
                glow !== 'none' && `box-shadow: ${glow};`
            ]);
            rule('.platform-icon', ['position: absolute;', 'top: -0.75em;', 'right: 12px;', 'padding: 3px 5px;', `background: ${solidBg};`, `border-radius: ${Math.min(s.radius, 10)}px;`, 'line-height: 0;']);
            rule('.text', ['display: block;']);
            break;
        case 'pills':
            rule('.message', ['display: grid;', 'grid-template-columns: auto auto 1fr;', 'align-items: end;', 'column-gap: 6px;']);
            rule('.author, .platform-icon', [
                'position: relative;', 'z-index: 1;', `margin-bottom: -${Math.max(s.borderWidth, 1)}px;`,
                'padding: 1px 10px;', 'font-size: 0.82em;', 'line-height: 1.5;', 'border-radius: 999px;',
                `background: ${solidBg};`,
                `border: ${border === 'none' ? '2px solid rgba(255, 255, 255, 0.25)' : border};`
            ]);
            rule('.author', ['grid-row: 1;', 'grid-column: 1;', 'justify-self: start;']);
            rule('.platform-icon', ['grid-row: 1;', 'grid-column: 2;', 'display: flex;', 'align-items: center;', 'gap: 5px;']);
            rule('.text', ['grid-row: 2;', 'grid-column: 1 / -1;', 'justify-self: start;', 'max-width: 100%;', 'box-sizing: border-box;']);
            break;
        case 'header':
            rule('.message', ['display: grid;', 'grid-template-columns: auto 1fr;', 'overflow: hidden;']);
            rule('.platform-icon, .author', ['grid-row: 1;', 'background: rgba(255, 255, 255, 0.08);', 'border-bottom: 1px solid rgba(255, 255, 255, 0.15);']);
            rule('.platform-icon', ['grid-column: 1;', 'display: flex;', 'align-items: center;', `padding: 5px 0 5px ${s.padding + 4}px;`]);
            rule('.author', ['grid-column: 2;', `padding: 5px ${s.padding + 4}px 5px 8px;`, 'font-size: 0.85em;', 'letter-spacing: 1px;']);
            rule('.text', ['grid-row: 2;', 'grid-column: 1 / -1;', `padding: ${pad};`]);
            break;
    }

    // Name
    rule('.author', [
        s.nameColorMode === 'user' ? 'color: var(--user-color);' : `color: ${colorFor(s.nameColorMode, s.nameColor)} !important;`,
        `font-weight: ${s.nameWeight};`,
        s.nameUppercase && 'text-transform: uppercase;'
    ]);
    if (!s.showColon) rule('.author-sep', ['display: none;']);
    else rule('.author-sep', ['margin-right: 4px;']);
    if (s.nameBrackets) {
        rule('.author-name::before', ["content: '[';"]);
        rule('.author-name::after', ["content: ']';"]);
    }

    // Platform icon
    rule('.platform-icon svg', [`width: ${s.iconSize}px;`, `height: ${s.iconSize}px;`, 'display: block;']);
    if (s.iconMode === 'hidden') {
        rule('.platform-icon', ['display: none;']);
    } else if (s.iconMode === 'text') {
        rule('.platform-icon svg', ['display: none;']);
        rule('.platform-icon', ['font-weight: bold;', 'font-size: 0.85em;']);
        const [open, close] = s.layout === 'line' ? ['[', ']'] : ['', ''];
        for (const p of PLATFORMS) rule(`.message[data-platform="${p}"] .platform-icon::before`, [`content: '${open}${p}${close}';`]);
    }

    rule('.text', [`color: ${s.textColor};`]);

    // Mentions (override the generic yellow highlight with the theme's own)
    rule('.message.mention-highlight', [
        'background: none !important;', 'border-left: none !important;', 'box-shadow: none !important;',
        s.layout !== 'pills' && `background: ${rgba(s.mentionColor, 0.25)} !important;`,
        s.layout !== 'pills' && `border: ${Math.max(s.borderWidth, 2)}px solid ${s.mentionColor} !important;`,
        s.layout !== 'pills' && `border-radius: ${s.radius}px;`
    ]);
    if (s.layout === 'pills') {
        rule('.message.mention-highlight .text', [`background: ${rgba(s.mentionColor, 0.35)};`, `border-color: ${s.mentionColor};`]);
    }

    if (anim) css.push(`@keyframes themeIn {\n    ${anim[1]}\n}`);

    // `*/` inside the JSON would end the comment early; "\/" is the same character in JSON.
    const json = JSON.stringify(s).replace(/\*\//g, '*\\/');
    return `/* @editor: ${json} */\n/* Made with the Multi-Chat theme editor */\n\n${css.join('\n\n')}\n`;
}

// Returns the editor settings stored in a theme, or null for hand-written CSS.
export function parseEditorSettings(css) {
    const m = String(css).match(/\/\*\s*@editor:\s*([\s\S]*?)\s*\*\//);
    if (!m) return null;
    try { return { ...DEFAULTS, ...JSON.parse(m[1]) }; } catch (e) { return null; }
}
