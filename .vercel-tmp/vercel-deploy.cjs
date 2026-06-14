#!/usr/bin/env node
/**
 * Vercel CLI Deployment Script (Cross-Platform)
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const isWindows = os.platform() === 'win32';
const ALLOWED_COMMANDS = new Set(['vercel', 'npm', 'pnpm', 'yarn']);

function log(msg) { console.error(msg); }

function commandExists(cmd) {
  if (!ALLOWED_COMMANDS.has(cmd)) throw new Error(`Command not in whitelist: ${cmd}`);
  try {
    if (isWindows) { return spawnSync('where', [cmd], { stdio: 'ignore' }).status === 0; }
    else { return spawnSync('sh', ['-c', `command -v "$1"`, '--', cmd], { stdio: 'ignore' }).status === 0; }
  } catch { return false; }
}

function getCommandOutput(cmd, args) {
  try {
    const result = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], shell: isWindows });
    return result.status === 0 ? (result.stdout || '').trim() : null;
  } catch { return null; }
}

function checkVercelInstalled() {
  if (!commandExists('vercel')) { log('Error: Vercel CLI is not installed'); process.exit(1); }
  log(`Vercel CLI version: ${getCommandOutput('vercel', ['--version']) || 'unknown'}`);
}

function checkLoginStatus() {
  log('Checking login status...');
  try {
    const result = spawnSync('vercel', ['whoami'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], shell: isWindows });
    const output = (result.stdout || '').trim();
    if (result.status === 0 && output && !output.includes('Error')) { log(`Logged in as: ${output}`); return true; }
  } catch {}
  return false;
}

function doDeploy(projectPath) {
  log('\nStarting deployment...');
  log('Deployment environment: Production');
  log('\n========================================');

  const result = spawnSync('vercel', ['--prod', '--yes'], {
    cwd: projectPath,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
    timeout: 300000,
    shell: isWindows
  });

  const output = (result.stdout || '') + (result.stderr || '');
  log(output);

  if (result.status !== 0) { log('Deployment failed'); process.exit(1); }

  const aliasedMatch = output.match(/Aliased:\s*(https:\/\/[a-zA-Z0-9.-]+\.vercel\.app)/i);
  const deploymentMatch = output.match(/Production:\s*(https:\/\/[a-zA-Z0-9.-]+\.vercel\.app)/i);
  const finalUrl = aliasedMatch?.[1] || deploymentMatch?.[1];

  log('\n========================================');
  log('Deployment successful!');
  log('========================================');
  if (finalUrl) {
    log(`Your API is live! Visit: ${finalUrl}`);
    console.log(JSON.stringify({ status: 'success', url: finalUrl }));
  } else {
    console.log(JSON.stringify({ status: 'success', message: 'Deployment successful' }));
  }
}

function main() {
  log('========================================');
  log('Vercel API Deployment');
  log('========================================\n');
  checkVercelInstalled();
  if (!checkLoginStatus()) { log('Error: Not logged in'); process.exit(1); }
  doDeploy(path.resolve('.'));
}
main();
