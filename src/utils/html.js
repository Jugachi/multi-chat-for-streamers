// Chat text and usernames end up in innerHTML on the client, so everything that
// came from a viewer must be escaped before we mix in our own emote <img> tags.
function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { escapeHtml };
