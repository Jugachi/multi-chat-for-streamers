// Tiny WebSocket client with the same on/emit feel as socket.io.
// Messages are JSON: { "event": "...", "data": ... }. Reconnects automatically
// (OBS keeps the overlay open while the app restarts).

export function createSocket(path = '/ws') {
    const handlers = new Map();
    let ws = null;
    let retryDelay = 1000;

    const fire = (event, data) => (handlers.get(event) || []).forEach(fn => fn(data));

    function connect() {
        const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
        ws = new WebSocket(url);
        ws.addEventListener('open', () => {
            retryDelay = 1000;
            fire('connect');
        });
        ws.addEventListener('message', (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch (err) { return; }
            if (msg && typeof msg.event === 'string') fire(msg.event, msg.data);
        });
        ws.addEventListener('close', () => {
            fire('disconnect');
            setTimeout(connect, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 10000);
        });
    }

    connect();
    return {
        on(event, fn) {
            if (!handlers.has(event)) handlers.set(event, []);
            handlers.get(event).push(fn);
        },
        emit(event, data) {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, data }));
        }
    };
}
