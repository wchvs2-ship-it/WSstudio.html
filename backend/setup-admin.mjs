import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.mjs';

const args = process.argv.slice(2);
if (args.some((arg, index) => !['--stdin', '--force', '--username'].includes(arg) && args[index - 1] !== '--username')) {
  throw new Error('Opções: --stdin, --username nome e --force. Nunca passe a senha como argumento.');
}
const usernameIndex = args.indexOf('--username');
if (usernameIndex >= 0 && (!args[usernameIndex + 1] || args[usernameIndex + 1].startsWith('--'))) {
  throw new Error('Informe um nome após --username.');
}
const username = (usernameIndex >= 0 ? args[usernameIndex + 1] : process.env.ADMIN_USERNAME) || 'william';
if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) throw new Error('Usuário inválido: use 3 a 64 letras, números, ponto, hífen ou sublinhado.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.DATA_DIR || resolve(root, '.data'));
const authPath = resolve(dataDir, 'admin-auth.json');
if (existsSync(authPath) && !args.includes('--force')) {
  throw new Error('O administrador já existe. Use --force para substituir a credencial.');
}

async function readHidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Use um terminal interativo ou --stdin para fornecer a senha por entrada padrão.');
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolvePassword, reject) => {
    let password = '';
    function cleanup() {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    }
    function onData(chunk) {
      for (const char of chunk) {
        if (char === '\u0003' || char === '\u0004') { cleanup(); reject(new Error('Configuração cancelada.')); return; }
        if (char === '\r' || char === '\n') { cleanup(); resolvePassword(password); return; }
        if (char === '\u007F' || char === '\b') password = [...password].slice(0, -1).join('');
        else if (char >= ' ') {
          password += char;
          if (password.length > 256) { cleanup(); reject(new Error('A senha excede 256 caracteres.')); return; }
        }
      }
    }
    process.stdin.on('data', onData);
  });
}

async function readPassword() {
  if (args.includes('--stdin')) {
    if (process.stdin.isTTY) throw new Error('--stdin exige entrada por pipe; no terminal, remova esta opção.');
    let value = '';
    for await (const chunk of process.stdin) {
      value += chunk.toString();
      if (value.length > 258) throw new Error('A senha excede 256 caracteres.');
    }
    return value.replace(/\r?\n$/, '');
  }
  const first = await readHidden('Senha do administrador (12 a 256 caracteres, entrada oculta): ');
  const confirmation = await readHidden('Repita a senha: ');
  if (first !== confirmation) throw new Error('As senhas não coincidem.');
  return first;
}

try {
  const password = await readPassword();
  const passwordHash = hashPassword(password);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const temporaryPath = resolve(dataDir, `.admin-auth-${randomBytes(8).toString('hex')}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify({ username, passwordHash })}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporaryPath, authPath);
  chmodSync(authPath, 0o600);
  console.log('Credencial do administrador salva em DATA_DIR/admin-auth.json. Nenhuma senha foi exibida.');
  console.log('Reinicie o backend para aplicar a credencial e invalidar as sessões anteriores.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
