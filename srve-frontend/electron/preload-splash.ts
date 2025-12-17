import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  onVersionInfo: (callback: (version: string, build: string) => void) => {
    ipcRenderer.on('version-info', (_event, version: string, build: string) => callback(version, build));
  },
  onStatus: (callback: (message: string) => void) => {
    ipcRenderer.on('status', (_event, message: string) => callback(message));
  },
});
