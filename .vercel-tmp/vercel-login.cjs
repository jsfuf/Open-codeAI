#!/usr/bin/env node
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const isWindows = os.platform() === 'win32';

function log(msg) { console.error(msg); }

function createSecureLogFile() {
  const tmpDir = path.join(process.cwd(), '.vercel-tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  return path.join(tmpDir, 'login.log');
}

const LOG_FILE = createSecureLogFile();

function startBackgroundLogin() {
  const logStream = fs.openSync(LOG_FILE, 'w');
  const child = spawn('vercel', ['login'], {
    detached: true,
    stdio: ['ignore', logStream, logStream],
    shell: isWindows
  });
  child.unref();
  log(`Background login process started (PID: ${child.pid})`);
  fs.writeFileSync(LOG_FILE + '.pid', String(child.pid));
  return child.pid;
}

function openBrowser(url) {
  const urlPattern = /^https:\/\/vercel\.com\/oauth\/device\?user_code=[A-Z0-9-]+$/;
  if (!urlPattern.test(url)) { log(`Please open the URL manually: ${url}`); return; }
  try {
    if (isWindows) {
      spawnSync('powershell', ['-Command', `Start-Process '${url}'`], { stdio: 'ignore', windowsHide: true });
    } else if (os.platform() === 'darwin') {
      spawnSync('open', [url], { stdio: 'ignore' });
    } else {
      spawnSync('xdg-open', [url], { stdio: 'ignore' });
    }
    log('Browser opened automatically');
  } catch (error) {
    log('Please open the URL manually');
  }
}

async function waitForAuthUrl() {
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      if (fs.existsSync(LOG_FILE)) {
        const content = fs.readFileSync(LOG_FILE, 'utf8');
        const match = content.match(/https:\/\/vercel\.com\/oauth\/device\?user_code=[A-Z0-9-]+(?=\s|$)/);
        if (match) return match[0];
      }
    } catch (e) {}
  }
  return null;
}

async function main() {
  log('========================================');
  log('Vercel Login');
  log('========================================\n');

  const loginPid = startBackgroundLogin();
  log('Waiting for authorization URL...');
  const authUrl = await waitForAuthUrl();

  if (authUrl) {
    log('\n========================================');
    log('Authorization URL extracted');
    log('========================================\n');
    openBrowser(authUrl);
    console.log(JSON.stringify({ status: 'needs_auth', auth_url: authUrl }));
  } else {
    log('Failed to get authorization URL');
    try { log('Log content: ' + fs.readFileSync(LOG_FILE, 'utf8')); } catch (e) {}
    process.exit(1);
  }
}
main();
