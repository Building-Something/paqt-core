import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';

const children = [];

function spawnProcess(command, args, name) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  children.push(child);
  child.on('exit', (code) => {
    console.log(`[paqt] ${name} exited with code ${code ?? 'unknown'}`);
    shutdown();
  });
  child.on('error', (error) => {
    console.error(`[paqt] failed to start ${name}:`, error);
    shutdown();
  });
  return child;
}

function killChild(child) {
  if (isWindows) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      child.kill('SIGTERM');
    }
    return;
  }
  child.kill('SIGTERM');
}

function shutdown() {
  for (const child of children) {
    killChild(child);
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const serverBin = fileURLToPath(new URL('./index.mjs', import.meta.url));
const viteBin = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));

spawnProcess(process.execPath, [serverBin], 'server');
spawnProcess(process.execPath, [viteBin], 'vite');