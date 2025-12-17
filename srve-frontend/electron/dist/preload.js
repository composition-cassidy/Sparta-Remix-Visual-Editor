"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('srve', {
    versions: process.versions,
    getBackendStatus: () => electron_1.ipcRenderer.invoke('srve:getBackendStatus'),
    openVideoDialog: () => electron_1.ipcRenderer.invoke('dialog:openVideo'),
    openMidiDialog: () => electron_1.ipcRenderer.invoke('dialog:openMidi'),
    openAudioDialog: () => electron_1.ipcRenderer.invoke('dialog:openAudio'),
    openTrimmer: (params) => electron_1.ipcRenderer.invoke('trimmer:open', params),
    closeTrimmer: (result) => electron_1.ipcRenderer.invoke('trimmer:close', result),
    onTrimmerResult: (callback) => {
        const handler = (_event, result) => callback(result);
        electron_1.ipcRenderer.on('trimmer:result', handler);
        return () => electron_1.ipcRenderer.removeListener('trimmer:result', handler);
    },
});
