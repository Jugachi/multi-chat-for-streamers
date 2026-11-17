const fs = require('fs');
const path = require('path');

// When packaged with pkg, __dirname points inside the read-only snapshot, so
// config.json must live next to the executable instead. Under Electron, the
// app is read-only (asar) and its install folder isn't reliably writable
// (e.g. Program Files on Windows), so use the standard per-user data folder.
const isElectron = !!process.versions.electron;
const isPkg = typeof process.pkg !== 'undefined';
const baseDir = isElectron
    ? require('electron').app.getPath('userData')
    : isPkg
        ? path.dirname(process.execPath)
        : path.join(__dirname, '..');

const configPath = path.join(baseDir, 'config.json');
const defaultConfig = { theme: 'dark-pill', background: 'transparent', mode: 'widget', mentions: true };

function loadConfig() {
    try { if (fs.existsSync(configPath)) return { ...defaultConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }; }
    catch (err) { console.error(err); }
    return { ...defaultConfig };
}

function writeConfig(cfg) {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

module.exports = { isElectron, isPkg, baseDir, loadConfig, writeConfig };
