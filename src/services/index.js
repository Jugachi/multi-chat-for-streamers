// Registry of supported platforms. Every service exports the same shape:
//   key        - id used in hub.streams / hub.serviceStatus / socket payloads
//   configKey  - field name in config.json
//   normalize  - turns user input (name, @name, URL...) into the channel id
//   connect    - connect(channel) to (re)connect, connect('') to disconnect
// To add a platform: create a module with that shape and list it here
// (plus an entry in hub.serviceStatus and an icon on the client).
const twitch = require('./twitch');
const youtube = require('./youtube');
const kick = require('./kick');
const tiktok = require('./tiktok');

module.exports = { twitch, youtube, kick, tiktok };
