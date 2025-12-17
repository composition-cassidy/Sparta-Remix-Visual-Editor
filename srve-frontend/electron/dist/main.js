"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
let mainWindow = null;
let trimmerWindow = null;
let splashWindow = null;
let backendProcess = null;
let backendStatus = {
    running: false,
    spawned: false,
    pid: null,
    lastHealth: null,
    lastError: null,
};
let isAppQuitting = false;
let backendStartPromise = null;
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function checkBackendHealthOnce() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1000);
    try {
        const response = await fetch('http://localhost:8765/health', { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`Health check failed: ${response.status}`);
        }
        const data = (await response.json());
        if (!data || typeof data.ffmpeg !== 'boolean') {
            throw new Error('Invalid /health response');
        }
        return data;
    }
    finally {
        clearTimeout(timeoutId);
    }
}
async function waitForBackendHealth(maxAttempts) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await checkBackendHealthOnce();
        }
        catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            await delay(1000);
        }
    }
    throw new Error(lastError ?? `Backend did not respond after ${maxAttempts} attempts`);
}
function computeBackendCwd() {
    if (!electron_1.app.isPackaged) {
        return path_1.default.resolve(electron_1.app.getAppPath(), '..', 'srve-backend');
    }
    return path_1.default.resolve(process.resourcesPath, 'srve-backend');
}
function computeBackendPython(cwd) {
    const override = process.env.SRVE_PYTHON_PATH;
    if (override && fs_1.default.existsSync(override)) {
        return override;
    }
    const winCandidate = path_1.default.join(cwd, '.venv', 'Scripts', 'python.exe');
    const nixCandidate = path_1.default.join(cwd, '.venv', 'bin', 'python');
    if (process.platform === 'win32' && fs_1.default.existsSync(winCandidate)) {
        return winCandidate;
    }
    if (process.platform !== 'win32' && fs_1.default.existsSync(nixCandidate)) {
        return nixCandidate;
    }
    return 'python';
}
function stopBackendProcess() {
    if (backendProcess && !backendProcess.killed) {
        backendProcess.kill();
    }
    backendProcess = null;
    backendStatus = {
        ...backendStatus,
        running: false,
        spawned: false,
        pid: null,
    };
}
function attachBackendHandlers(proc) {
    proc.stdout.on('data', (chunk) => {
        const text = typeof chunk === 'string' ? chunk : String(chunk);
        console.log(`[backend] ${text}`);
    });
    proc.stderr.on('data', (chunk) => {
        const text = typeof chunk === 'string' ? chunk : String(chunk);
        console.error(`[backend] ${text}`);
    });
    proc.on('exit', async (code, signal) => {
        const exitInfo = `Backend exited (code: ${code ?? 'null'}, signal: ${signal ?? 'null'})`;
        backendProcess = null;
        backendStatus = {
            ...backendStatus,
            running: false,
            spawned: false,
            pid: null,
            lastError: exitInfo,
        };
        if (isAppQuitting) {
            return;
        }
        const result = await electron_1.dialog.showMessageBox({
            type: 'error',
            title: 'SRVE Backend Crash',
            message: 'The SRVE backend process has stopped.',
            detail: exitInfo,
            buttons: ['Restart', 'Quit'],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
        });
        if (result.response === 0) {
            const ok = await ensureBackendRunning();
            if (!ok) {
                electron_1.app.quit();
            }
            return;
        }
        electron_1.app.quit();
    });
}
async function startBackendProcess() {
    const cwd = computeBackendCwd();
    const pythonExe = computeBackendPython(cwd);
    const child = (0, child_process_1.spawn)(pythonExe, ['main.py'], {
        cwd,
        env: {
            ...process.env,
            SRVE_FFMPEG_PATH: process.env.SRVE_FFMPEG_PATH,
            SRVE_FFPROBE_PATH: process.env.SRVE_FFPROBE_PATH,
        },
        stdio: 'pipe',
    });
    backendProcess = child;
    backendStatus = {
        ...backendStatus,
        spawned: true,
        pid: child.pid ?? null,
        lastError: null,
    };
    attachBackendHandlers(child);
    await new Promise((resolve, reject) => {
        const onError = (err) => {
            child.off('spawn', onSpawn);
            backendStatus = {
                ...backendStatus,
                lastError: err.message,
            };
            reject(err);
        };
        const onSpawn = () => {
            child.off('error', onError);
            resolve();
        };
        child.once('error', onError);
        child.once('spawn', onSpawn);
    });
}
async function ensureBackendRunning() {
    if (backendStartPromise) {
        return backendStartPromise;
    }
    backendStartPromise = (async () => {
        while (true) {
            try {
                const existing = await checkBackendHealthOnce();
                backendStatus = {
                    ...backendStatus,
                    running: true,
                    lastHealth: existing,
                    lastError: null,
                };
                return true;
            }
            catch {
            }
            try {
                await startBackendProcess();
                const health = await waitForBackendHealth(10);
                backendStatus = {
                    ...backendStatus,
                    running: true,
                    lastHealth: health,
                    lastError: null,
                };
                return true;
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                backendStatus = {
                    ...backendStatus,
                    running: false,
                    lastError: message,
                };
                const result = await electron_1.dialog.showMessageBox({
                    type: 'error',
                    title: 'Backend Connection Failed',
                    message: 'Could not start or connect to the SRVE backend.',
                    detail: message,
                    buttons: ['Retry', 'Quit'],
                    defaultId: 0,
                    cancelId: 1,
                    noLink: true,
                });
                if (result.response === 0) {
                    stopBackendProcess();
                    continue;
                }
                return false;
            }
        }
    })().finally(() => {
        backendStartPromise = null;
    });
    return backendStartPromise;
}
function createSplashWindow() {
    splashWindow = new electron_1.BrowserWindow({
        width: 600,
        height: 350,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        center: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        webPreferences: {
            preload: path_1.default.join(__dirname, 'preload-splash.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    const isDev = !electron_1.app.isPackaged;
    if (isDev) {
        splashWindow.loadFile(path_1.default.join(electron_1.app.getAppPath(), 'splash.html'));
    }
    else {
        splashWindow.loadFile(path_1.default.join(electron_1.app.getAppPath(), 'dist', 'splash.html'));
    }
    splashWindow.on('close', (e) => {
        if (mainWindow === null) {
            e.preventDefault();
        }
    });
    splashWindow.webContents.on('did-finish-load', () => {
        const packageJson = require('../../package.json');
        const version = packageJson.version || '0.1.0';
        const build = process.env.BUILD_NUMBER || '001';
        splashWindow?.webContents.send('version-info', version, build);
    });
}
function updateSplashStatus(message) {
    splashWindow?.webContents.send('status', message);
}
function createMainWindow() {
    const isDev = !electron_1.app.isPackaged;
    mainWindow = new electron_1.BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1400,
        minHeight: 900,
        backgroundColor: '#1a1a1a',
        show: false,
        webPreferences: {
            preload: path_1.default.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            devTools: isDev,
        },
    });
    if (isDev) {
        const devServerUrl = process.env.SRVE_DEV_SERVER_URL ?? 'http://localhost:5173';
        mainWindow.loadURL(devServerUrl);
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
    else {
        mainWindow.loadFile(path_1.default.join(electron_1.app.getAppPath(), 'dist', 'index.html'));
    }
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}
electron_1.ipcMain.handle('srve:getBackendStatus', () => backendStatus);
electron_1.ipcMain.handle('dialog:openVideo', async () => {
    const options = {
        properties: ['openFile', 'multiSelections'],
        filters: [
            {
                name: 'Video Files',
                extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm'],
            },
        ],
    };
    const result = mainWindow
        ? await electron_1.dialog.showOpenDialog(mainWindow, options)
        : await electron_1.dialog.showOpenDialog(options);
    if (result.canceled) {
        return [];
    }
    return result.filePaths;
});
electron_1.ipcMain.handle('dialog:openAudio', async () => {
    const options = {
        properties: ['openFile'],
        filters: [
            {
                name: 'Audio Files',
                extensions: ['mp3', 'wav', 'ogg', 'flac', 'aac'],
            },
        ],
    };
    const result = mainWindow
        ? await electron_1.dialog.showOpenDialog(mainWindow, options)
        : await electron_1.dialog.showOpenDialog(options);
    if (result.canceled) {
        return [];
    }
    return result.filePaths;
});
electron_1.ipcMain.handle('dialog:openMidi', async () => {
    const options = {
        properties: ['openFile'],
        filters: [
            {
                name: 'MIDI Files',
                extensions: ['mid', 'midi'],
            },
        ],
    };
    const result = mainWindow
        ? await electron_1.dialog.showOpenDialog(mainWindow, options)
        : await electron_1.dialog.showOpenDialog(options);
    if (result.canceled) {
        return [];
    }
    return result.filePaths;
});
electron_1.ipcMain.handle('trimmer:open', async (_event, params) => {
    if (trimmerWindow && !trimmerWindow.isDestroyed()) {
        trimmerWindow.focus();
        return;
    }
    const isDev = !electron_1.app.isPackaged;
    trimmerWindow = new electron_1.BrowserWindow({
        width: 1000,
        height: 700,
        minWidth: 800,
        minHeight: 600,
        backgroundColor: '#1a1a1a',
        title: `Clip Trimmer - ${params.videoName}`,
        parent: mainWindow ?? undefined,
        modal: false,
        webPreferences: {
            preload: path_1.default.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            devTools: isDev,
            webSecurity: false,
        },
    });
    const queryParams = new URLSearchParams({
        videoPath: params.videoPath,
        videoName: params.videoName,
        videoDuration: String(params.videoDuration),
        videoFps: String(params.videoFps),
        currentIn: String(params.currentIn),
        currentOut: String(params.currentOut),
        layerId: params.layerId,
    });
    if (isDev) {
        const devServerUrl = process.env.SRVE_DEV_SERVER_URL ?? 'http://localhost:5173';
        trimmerWindow.loadURL(`${devServerUrl}/trimmer.html?${queryParams.toString()}`);
        trimmerWindow.webContents.openDevTools({ mode: 'detach' });
    }
    else {
        trimmerWindow.loadFile(path_1.default.join(electron_1.app.getAppPath(), 'dist', 'trimmer.html'), {
            search: queryParams.toString(),
        });
    }
    trimmerWindow.on('closed', () => {
        trimmerWindow = null;
    });
});
electron_1.ipcMain.handle('trimmer:close', async (_event, result) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('trimmer:result', result);
    }
    if (trimmerWindow && !trimmerWindow.isDestroyed()) {
        trimmerWindow.close();
    }
    trimmerWindow = null;
});
electron_1.ipcMain.handle('trimmer:getParams', () => {
    return null;
});
electron_1.app.whenReady().then(async () => {
    createSplashWindow();
    await delay(100);
    updateSplashStatus('Starting backend server...');
    const backendOk = await ensureBackendRunning();
    if (!backendOk) {
        splashWindow?.close();
        electron_1.app.quit();
        return;
    }
    updateSplashStatus('Connecting to render engine...');
    await delay(300);
    updateSplashStatus('Loading FFmpeg components...');
    await delay(300);
    updateSplashStatus('Preparing workspace...');
    createMainWindow();
    mainWindow?.once('ready-to-show', async () => {
        updateSplashStatus('Ready to remix!');
        await delay(500);
        mainWindow?.show();
        splashWindow?.close();
        splashWindow = null;
    });
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            createMainWindow();
        }
    });
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
electron_1.app.on('before-quit', () => {
    isAppQuitting = true;
    stopBackendProcess();
});
