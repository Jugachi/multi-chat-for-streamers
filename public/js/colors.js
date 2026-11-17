// --- Username color contrast helpers ---
// Parses any valid CSS color string into {r,g,b,a} by letting the canvas
// 2D context normalize it (handles hex, rgb(), rgba(), named colors, etc).
let colorParseCtx = null;
function parseCssColor(str) {
    if (!colorParseCtx) colorParseCtx = document.createElement('canvas').getContext('2d');
    colorParseCtx.fillStyle = '#000000';
    colorParseCtx.fillStyle = str;
    const normalized = colorParseCtx.fillStyle;
    if (normalized[0] === '#') {
        const num = parseInt(normalized.slice(1), 16);
        return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255, a: 1 };
    }
    const m = normalized.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 };
}

// Flattens a (possibly translucent) color onto a black backdrop, since every
// theme in this app is dark-on-dark (no light theme/background exists).
function flattenOnBlack(rgba) {
    return { r: rgba.r * rgba.a, g: rgba.g * rgba.a, b: rgba.b * rgba.a };
}

function relativeLuminance([r, g, b]) {
    const [rs, gs, bs] = [r, g, b].map((c) => {
        c /= 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrastRatio(rgbA, rgbB) {
    const lA = relativeLuminance(rgbA) + 0.05;
    const lB = relativeLuminance(rgbB) + 0.05;
    return lA > lB ? lA / lB : lB / lA;
}

// If `colorStr` doesn't contrast enough against the message bubble behind it,
// fall back to whichever of white/black is more readable on that background.
export function getReadableUsernameColor(colorStr, bgElement) {
    const bg = flattenOnBlack(parseCssColor(getComputedStyle(bgElement).backgroundColor));
    const fg = parseCssColor(colorStr);
    if (contrastRatio([fg.r, fg.g, fg.b], [bg.r, bg.g, bg.b]) >= 4.5) {
        return colorStr;
    }
    const whiteContrast = contrastRatio([255, 255, 255], [bg.r, bg.g, bg.b]);
    const blackContrast = contrastRatio([0, 0, 0], [bg.r, bg.g, bg.b]);
    return whiteContrast >= blackContrast ? '#ffffff' : '#000000';
}
