const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    let mainWindow;

    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    function createWindow(port) {
        mainWindow = new BrowserWindow({
            width: 1100,
            height: 750,
            title: 'Multi-Chat',
            autoHideMenuBar: true,
        });
        mainWindow.loadURL(`http://localhost:${port}`);
    }

    app.whenReady().then(() => {
        Menu.setApplicationMenu(null);

        const { server, PORT } = require('../server.js');
        if (server.listening) createWindow(PORT);
        else server.once('listening', () => createWindow(PORT));

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow(PORT);
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}
