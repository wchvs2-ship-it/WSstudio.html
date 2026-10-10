import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');

export function runWrangler(args, { input, capture = false, quiet = false } = {}) {
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
  delete env.WS_ADMIN_PASSWORD;
  env.XDG_CONFIG_HOME ||= resolve(root, '.cloudflare/config');
  mkdirSync(env.XDG_CONFIG_HOME, { recursive: true, mode: 0o700 });
  return new Promise((resolveRun, reject) => {
    const piped = capture || quiet;
    const child = spawn(process.execPath, [wrangler, ...args], {
      cwd: root, env,
      stdio: [input === undefined ? 'inherit' : 'pipe', piped ? 'pipe' : 'inherit', piped ? 'pipe' : 'inherit']
    });
    let stdout = '', stderr = '';
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    function cleanup() {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }
    if (piped) {
      child.stdout.on('data', chunk => { stdout += chunk.toString(); if (!quiet) process.stdout.write(chunk); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); if (!quiet) process.stderr.write(chunk); });
    }
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => { cleanup(); resolveRun({ code: code ?? (signal ? 1 : 0), stdout, stderr }); });
    if (input !== undefined) {
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') child.emit('error', error); });
      child.stdin.end(input);
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = (await runWrangler(process.argv.slice(2))).code; }
  catch { console.error('Não foi possível executar o Wrangler. Confira a instalação e o acesso à Cloudflare.'); process.exitCode = 1; }
}
