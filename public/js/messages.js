// Message rendering shared by the chat (main.js) and the theme editor preview
// (editor.js), so themes look identical in both.
import { icons, brandColors } from './icons.js';
import { getReadableUsernameColor } from './colors.js';

// Platforms where chatters pick their own name color.
const userColorPlatforms = new Set(['Twitch', 'Kick']);

// data: { platform, author (HTML-escaped), message (HTML), color }
// Hooks available to themes:
//   .message[data-platform="Twitch"]   per-platform styling
//   var(--platform-color)              brand color of the platform
//   var(--user-color)                  chatter's readable name color (set by applyMessageColors)
//   .author > .author-name / .author-sep, .platform-icon, .text
export function createMessageElement(data, { mention = false, doc = document } = {}) {
    const msgDiv = doc.createElement('div');
    msgDiv.className = 'message';
    if (mention) msgDiv.classList.add('mention-highlight');

    msgDiv.innerHTML = `
        <div class="platform-icon">${icons[data.platform] || ''}</div>
        <span class="author"><span class="author-name">${data.author}</span><span class="author-sep">:</span></span>
        <span class="text">${data.message}</span>
    `;
    msgDiv.dataset.platform = data.platform;
    const brand = brandColors[data.platform] || '#9146FF';
    msgDiv.style.setProperty('--platform-color', brand);
    // Platform logo always uses the brand color, never the chatter's name color.
    msgDiv.querySelector('.platform-icon').style.color = brand;
    return msgDiv;
}

// Must run after the element is in the DOM: Twitch/Kick names use the viewer's
// chosen color, which can be too close to the bubble background to read, so we
// measure the real rendered background and fix it up.
export function applyMessageColors(msgElement, data) {
    let userColor = brandColors[data.platform] || '#9146FF';
    if (userColorPlatforms.has(data.platform) && data.color) {
        userColor = getReadableUsernameColor(data.color, msgElement);
        const authorSpan = msgElement.querySelector('.author');
        if (authorSpan) authorSpan.style.color = userColor;
    }
    msgElement.style.setProperty('--user-color', userColor);
}

// --- Typewriter effect ---
// Themes opt in with `body { --typewriter: 1; }`.
export function themeWantsTypewriter(doc = document) {
    return getComputedStyle(doc.body).getPropertyValue('--typewriter').trim() === '1';
}

// Text appears letter by letter; emotes pop in whole. Long messages type faster
// so nothing takes longer than ~2.5s. onTick runs after every step (for scrolling).
export function typewrite(container, onTick = () => {}) {
    const doc = container.ownerDocument;
    const queue = [];
    (function collect(node, parent) {
        for (const child of [...node.childNodes]) {
            if (child.nodeType === Node.TEXT_NODE) {
                for (const ch of child.textContent) queue.push({ parent, ch });
            } else if (child.tagName === 'IMG') {
                queue.push({ parent, el: child });
            } else {
                const shell = child.cloneNode(false);
                queue.push({ parent, el: shell });
                collect(child, shell);
            }
        }
    })(container, container);

    container.replaceChildren();
    container.classList.add('typing');
    const delay = Math.max(8, Math.min(35, 2500 / Math.max(queue.length, 1)));
    let i = 0;
    const timer = setInterval(() => {
        if (i >= queue.length || !container.isConnected) {
            clearInterval(timer);
            container.classList.remove('typing');
            container.classList.add('typed');
            return;
        }
        const item = queue[i++];
        if (item.ch !== undefined) {
            const last = item.parent.lastChild;
            if (last && last.nodeType === Node.TEXT_NODE) last.textContent += item.ch;
            else item.parent.appendChild(doc.createTextNode(item.ch));
        } else {
            item.parent.appendChild(item.el);
        }
        onTick();
    }, delay);
}
