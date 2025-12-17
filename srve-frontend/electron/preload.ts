import { contextBridge, ipcRenderer } from 'electron';

export type TrimmerOpenParams = {
  videoPath: string;
  videoName: string;
  videoDuration: number;
  videoFps: number;
  currentIn: number;
  currentOut: number;
  layerId: string;
};

export type TrimmerResult = {
  layerId: string;
  inPoint: number;
  outPoint: number;
  cancelled: boolean;
};

contextBridge.exposeInMainWorld('srve', {
  versions: process.versions,
  getBackendStatus: () => ipcRenderer.invoke('srve:getBackendStatus'),
  openVideoDialog: () => ipcRenderer.invoke('dialog:openVideo') as Promise<string[]>,
  openMidiDialog: () => ipcRenderer.invoke('dialog:openMidi') as Promise<string[]>,
  openAudioDialog: () => ipcRenderer.invoke('dialog:openAudio') as Promise<string[]>,
  openTrimmer: (params: TrimmerOpenParams) => ipcRenderer.invoke('trimmer:open', params),
  closeTrimmer: (result: TrimmerResult) => ipcRenderer.invoke('trimmer:close', result),
  onTrimmerResult: (callback: (result: TrimmerResult) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, result: TrimmerResult) => callback(result);
    ipcRenderer.on('trimmer:result', handler);
    return () => ipcRenderer.removeListener('trimmer:result', handler);
  },
});
