const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { pathToFileURL } = require('url');

const PORT = 34197;

process.env.PORT = String(PORT);
process.env.ATL_UPLOADS_DIR = path.join(app.getPath('userData'), 'uploads');
process.env.ATL_PROJECTS_DIR = path.join(app.getPath('userData'), 'projects');

const serverPath = path.join(__dirname, '..', 'server.mjs');

function log(...args) {
  console.log('[AI-VE]', ...args);
}

function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
    candidates.push('/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary');
  } else if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
      // Edge is Chromium-based and preinstalled on Windows 10/11 — works as a fallback
      path.join(process.env.PROGRAMFILES || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft\\Edge\\Application\\msedge.exe')
    );
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/chrome');
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function findFfmpeg() {
  const envPath = process.env.FFMPEG_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const names = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'];
  // GUI-launched apps on macOS don't inherit the shell PATH, so also check
  // common install locations (Homebrew, MacPorts, winget/choco, local installs).
  const extraDirs = process.platform === 'win32' ? [
    'C:\\ffmpeg\\bin',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\WinGet\\Links'),
    'C:\\ProgramData\\chocolatey\\bin'
  ] : [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/local/bin',
    path.join(process.env.HOME || '', 'bin')
  ];
  const paths = (process.env.PATH || '').split(path.delimiter).concat(extraDirs);
  for (const p of paths) {
    for (const name of names) {
      const full = path.join(p, name);
      if (p && fs.existsSync(full)) return full;
    }
  }
  return null;
}

async function waitForServer(url, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
          if (res.statusCode === 200) resolve();
          else reject(new Error(`status ${res.statusCode}`));
        });
        req.on('error', reject);
        req.setTimeout(500, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw new Error('Server did not start in time');
}

async function startServer() {
  if (!fs.existsSync(serverPath)) {
    throw new Error(`Server not found at ${serverPath}`);
  }

  const chrome = findChrome();
  if (chrome) {
    process.env.PUPPETEER_EXECUTABLE_PATH = chrome;
  }

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    dialog.showErrorBox('Missing dependency', 'FFmpeg was not found. Please install FFmpeg and make sure it is in your PATH.\n\nmacOS: brew install ffmpeg\nWindows: winget install ffmpeg  (then restart the app)\nUbuntu/Debian: sudo apt install ffmpeg');
    app.quit();
    return;
  }
  const ffmpegDir = path.dirname(ffmpeg);
  process.env.PATH = ffmpegDir + path.delimiter + process.env.PATH;

  log('starting server in main process', serverPath);
  await import(pathToFileURL(serverPath).href);
}

async function createWindow() {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    title: 'AI Video Editor',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: false
    }
  });

  const startUrl = `http://localhost:${PORT}`;
  await waitForServer(startUrl + '/api/health');
  win.loadURL(startUrl);
}

app.whenReady().then(async () => {
  try {
    await startServer();
    await createWindow();
  } catch (err) {
    dialog.showErrorBox('Failed to start AI Video Editor', err.message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
