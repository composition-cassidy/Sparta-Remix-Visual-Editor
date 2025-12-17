"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('electronAPI', {
    onVersionInfo: (callback) => {
        electron_1.ipcRenderer.on('version-info', (_event, version, build) => callback(version, build));
    },
    onStatus: (callback) => {
        electron_1.ipcRenderer.on('status', (_event, message) => callback(message));
    },
});
