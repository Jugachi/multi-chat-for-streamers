// Theme discovery, custom theme storage, and hot reload.
//
// Built-in themes: public/themes/*.css (read-only, shipped with the app)
// Custom themes:   custom-themes/*.css next to config.json (created by the theme
//                  editor at /editor.html, or dropped in by hand)
//
// Each theme file may start with a `/* @name: Display Name */` comment.
// Theme ids: built-in = file name ("dark-pill"), custom = "custom-<file name>".
const fs = require('fs');
const path = require('path');
const express = require('express');
const { baseDir, isPkg } = require('./config');

const BUILTIN_DIR = path.join(__dirname, '..', 'public', 'themes');
const CUSTOM_DIR = path.join(baseDir, 'custom-themes');
const CUSTOM_PREFIX = 'custom-';
const MAX_THEME_BYTES = 200 * 1024;

fs.mkdirSync(CUSTOM_DIR, { recursive: true });

function readName(css, fallbackId) {
    const m = css.match(/@name:\s*(.+?)\s*\*\//);
    if (m) return m[1];
    // "retro-arcade" -> "Retro Arcade"
    return fallbackId.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function listDir(dir, custom) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.css')); }
    catch (e) { return []; }
    return files.map((file) => {
        const slug = file.slice(0, -4);
        let css = '';
        try { css = fs.readFileSync(path.join(dir, file), 'utf8').slice(0, 2000); } catch (e) { /* unreadable */ }
        return {
            id: custom ? CUSTOM_PREFIX + slug : slug,
            name: readName(css, slug),
            url: custom ? `/custom-themes/${encodeURIComponent(file)}` : `/themes/${encodeURIComponent(file)}`,
            custom
        };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

function listThemes() {
    return [...listDir(BUILTIN_DIR, false), ...listDir(CUSTOM_DIR, true)];
}

function slugify(name) {
    const slug = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return slug || 'my-theme';
}

// Writes custom-themes/<slug>.css with a fresh @name header.
function saveTheme(name, css) {
    const displayName = String(name || '').replace(/\*\//g, '').trim().slice(0, 60) || 'My Theme';
    const body = String(css || '').replace(/^\s*\/\*\s*@name:.*?\*\/\s*/, '');
    const slug = slugify(displayName);
    fs.writeFileSync(path.join(CUSTOM_DIR, `${slug}.css`), `/* @name: ${displayName} */\n${body}`);
    return { id: CUSTOM_PREFIX + slug, slug, name: displayName };
}

function deleteTheme(id) {
    if (!id.startsWith(CUSTOM_PREFIX)) throw new Error('Only custom themes can be deleted');
    const slug = slugify(id.slice(CUSTOM_PREFIX.length));
    fs.unlinkSync(path.join(CUSTOM_DIR, `${slug}.css`));
}

// The server listens on all interfaces (OBS may run on another PC), so only
// allow changes to theme files from this machine.
function localOnly(req, res, next) {
    const ip = req.socket.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    res.status(403).json({ error: 'Themes can only be changed from the computer running Multi-Chat.' });
}

function registerRoutes(app) {
    app.use('/custom-themes', express.static(CUSTOM_DIR, { cacheControl: false }));

    app.get('/api/themes', (req, res) => res.json(listThemes()));

    app.post('/api/themes', localOnly, express.json({ limit: MAX_THEME_BYTES }), (req, res) => {
        const { name, css } = req.body || {};
        if (typeof css !== 'string' || !css.trim()) return res.status(400).json({ error: 'Theme CSS is empty.' });
        try { res.json(saveTheme(name, css)); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/themes/:id', localOnly, (req, res) => {
        try { deleteTheme(req.params.id); res.json({ ok: true }); }
        catch (err) { res.status(400).json({ error: err.message }); }
    });
}

// Calls onChange(themes) whenever a theme file is added, edited or removed.
// Built-in themes are only watched in development (they're read-only when packaged).
function watchThemes(onChange) {
    let timer = null;
    const trigger = () => {
        clearTimeout(timer);
        // Editors often write a file in several steps; wait for things to settle.
        timer = setTimeout(() => onChange(listThemes()), 250);
    };
    const dirs = [CUSTOM_DIR];
    if (!isPkg && !process.versions.electron) dirs.push(BUILTIN_DIR);
    for (const dir of dirs) {
        try { fs.watch(dir, trigger); }
        catch (err) { console.log(`Theme hot reload unavailable for ${dir}: ${err.message}`); }
    }
}

module.exports = { CUSTOM_DIR, listThemes, registerRoutes, watchThemes };
