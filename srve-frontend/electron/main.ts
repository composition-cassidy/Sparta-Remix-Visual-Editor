import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';

let mainWindow: BrowserWindow | null = null;
let trimmerWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;

type BackendHealth = {
  status: string;
  ffmpeg: boolean;
};

type BackendStatus = {
  running: boolean;
  spawned: boolean;
  pid: number | null;
  lastHealth: BackendHealth | null;
  lastError: string | null;
};

let backendProcess: ChildProcessWithoutNullStreams | null = null;
let backendStatus: BackendStatus = {
  running: false,
  spawned: false,
  pid: null,
  lastHealth: null,
  lastError: null,
};

let isAppQuitting = false;
let backendStartPromise: Promise<boolean> | null = null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkBackendHealthOnce(): Promise<BackendHealth> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch('http://localhost:8765/health', { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`);
    }
    const data = (await response.json()) as BackendHealth;
    if (!data || typeof data.ffmpeg !== 'boolean') {
      throw new Error('Invalid /health response');
    }
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function waitForBackendHealth(maxAttempts: number): Promise<BackendHealth> {
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await checkBackendHealthOnce();
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
      await delay(1000);
    }
  }
  throw new Error(lastError ?? `Backend did not respond after ${maxAttempts} attempts`);
}

function computeBackendCwd(): string {
  if (!app.isPackaged) {
    return path.resolve(app.getAppPath(), '..', 'srve-backend');
  }

  return path.resolve(process.resourcesPath, 'srve-backend');
}

function computeBackendPython(cwd: string): string {
  const override = process.env.SRVE_PYTHON_PATH;
  if (override && fs.existsSync(override)) {
    return override;
  }

  const winCandidate = path.join(cwd, '.venv', 'Scripts', 'python.exe');
  const nixCandidate = path.join(cwd, '.venv', 'bin', 'python');

  if (process.platform === 'win32' && fs.existsSync(winCandidate)) {
    return winCandidate;
  }
  if (process.platform !== 'win32' && fs.existsSync(nixCandidate)) {
    return nixCandidate;
  }

  return 'python';
}

function stopBackendProcess(): void {
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

function attachBackendHandlers(proc: ChildProcessWithoutNullStreams) {
  proc.stdout.on('data', (chunk: unknown) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    console.log(`[backend] ${text}`);
  });

  proc.stderr.on('data', (chunk: unknown) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    console.error(`[backend] ${text}`);
  });

  proc.on('exit', async (code: number | null, signal: NodeJS.Signals | null) => {
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

    const result = await dialog.showMessageBox({
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
        app.quit();
      }
      return;
    }

    app.quit();
  });
}

async function startBackendProcess(): Promise<void> {
  const cwd = computeBackendCwd();
  const pythonExe = computeBackendPython(cwd);

  const child = spawn(pythonExe, ['main.py'], {
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

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
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

async function ensureBackendRunning(): Promise<boolean> {
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
      } catch {
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
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        backendStatus = {
          ...backendStatus,
          running: false,
          lastError: message,
        };

        const result = await dialog.showMessageBox({
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
  splashWindow = new BrowserWindow({
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
      preload: path.join(__dirname, 'preload-splash.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = !app.isPackaged;
  if (isDev) {
    splashWindow.loadFile(path.join(app.getAppPath(), 'splash.html'));
  } else {
    splashWindow.loadFile(path.join(app.getAppPath(), 'dist', 'splash.html'));
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

function updateSplashStatus(message: string) {
  splashWindow?.webContents.send('status', message);
}

function createMainWindow() {
  const isDev = !app.isPackaged;

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1400,
    minHeight: 900,
    backgroundColor: '#1a1a1a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: isDev,
    },
  });

  if (isDev) {
    const devServerUrl = process.env.SRVE_DEV_SERVER_URL ?? 'http://localhost:5173';
    mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('srve:getBackendStatus', () => backendStatus);

ipcMain.handle('dialog:openVideo', async () => {
  const options: OpenDialogOptions = {
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Video Files',
        extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm'],
      },
    ],
  };

  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled) {
    return [];
  }
  return result.filePaths;
});

ipcMain.handle('dialog:openAudio', async () => {
  const options: OpenDialogOptions = {
    properties: ['openFile'],
    filters: [
      {
        name: 'Audio Files',
        extensions: ['mp3', 'wav', 'ogg', 'flac', 'aac'],
      },
    ],
  };

  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled) {
    return [];
  }
  return result.filePaths;
});

ipcMain.handle('dialog:openMidi', async () => {
  const options: OpenDialogOptions = {
    properties: ['openFile'],
    filters: [
      {
        name: 'MIDI Files',
        extensions: ['mid', 'midi'],
      },
    ],
  };

  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled) {
    return [];
  }
  return result.filePaths;
});

type TrimmerOpenParams = {
  videoPath: string;
  videoName: string;
  videoDuration: number;
  videoFps: number;
  currentIn: number;
  currentOut: number;
  layerId: string;
};

type TrimmerResult = {
  layerId: string;
  inPoint: number;
  outPoint: number;
  cancelled: boolean;
};

ipcMain.handle('trimmer:open', async (_event, params: TrimmerOpenParams) => {
  if (trimmerWindow && !trimmerWindow.isDestroyed()) {
    trimmerWindow.focus();
    return;
  }

  const isDev = !app.isPackaged;

  trimmerWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#1a1a1a',
    title: `Clip Trimmer - ${params.videoName}`,
    parent: mainWindow ?? undefined,
    modal: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
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
  } else {
    trimmerWindow.loadFile(path.join(app.getAppPath(), 'dist', 'trimmer.html'), {
      search: queryParams.toString(),
    });
  }

  trimmerWindow.on('closed', () => {
    trimmerWindow = null;
  });
});

ipcMain.handle('trimmer:close', async (_event, result: TrimmerResult) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('trimmer:result', result);
  }
  if (trimmerWindow && !trimmerWindow.isDestroyed()) {
    trimmerWindow.close();
  }
  trimmerWindow = null;
});

ipcMain.handle('trimmer:getParams', () => {
  return null;
});

app.whenReady().then(async () => {
  createSplashWindow();

  await delay(100);

  updateSplashStatus('Starting backend server...');
  
  const backendOk = await ensureBackendRunning();
  if (!backendOk) {
    splashWindow?.close();
    app.quit();
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isAppQuitting = true;
  stopBackendProcess();
});
