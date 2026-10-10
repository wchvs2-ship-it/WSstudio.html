import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.mjs';
import { readPassword } from './password-input.mjs';

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

try {
  const password = await readPassword({ stdin: args.includes('--stdin') });
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
