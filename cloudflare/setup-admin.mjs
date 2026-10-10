import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../backend/auth.mjs';
import { readPassword } from '../backend/password-input.mjs';
import { runWrangler } from './cli.mjs';

const args = process.argv.slice(2);
try {
  if (args.some(arg => !['--local', '--stdin', '--force', '--from-env'].includes(arg))) {
    throw new Error('Opções: --local, --stdin, --from-env e --force. Nunca passe a senha como argumento.');
  }
  if (args.includes('--stdin') && args.includes('--from-env')) throw new Error('Escolha somente uma fonte privada para a senha.');
  const local = args.includes('--local');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const path = resolve(root, '.dev.vars');
  const previous = local && existsSync(path) ? readFileSync(path, 'utf8') : '';
  const line = /^\s*ADMIN_PASSWORD_HASH\s*=.*$/m;
  if (local && line.test(previous) && !args.includes('--force')) {
    throw new Error('Já existe uma credencial local. Use --force para substituí-la.');
  }
  if (!local) {
    const identity = await runWrangler(['whoami'], { capture: true, quiet: true });
    if (identity.code !== 0 || /not authenticated|not logged in|not currently logged in/i.test(identity.stdout + identity.stderr)) {
      throw new Error('Conecte sua conta com npm run cloud:login ou configure o token da Cloudflare de forma privada antes de cadastrar a senha.');
    }
  }
  const password = args.includes('--from-env')
    ? process.env.WS_ADMIN_PASSWORD
    : await readPassword({ stdin: args.includes('--stdin') });
  if (args.includes('--from-env') && !password) throw new Error('Configure WS_ADMIN_PASSWORD de forma privada nas variáveis do ambiente; não envie a senha pelo chat.');
  const encoded = hashPassword(password);
  if (local) {
    const setting = `ADMIN_PASSWORD_HASH=${JSON.stringify(encoded)}`;
    const next = line.test(previous) ? previous.replace(line, setting) : `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}${setting}\n`;
    writeFileSync(path, next, { mode: 0o600 });
    chmodSync(path, 0o600);
    console.log('Hash salvo em .dev.vars, fora do Git. Reinicie cloud:dev para aplicar e invalidar as sessões antigas.');
  } else {
    const result = await runWrangler(['secret', 'put', 'ADMIN_PASSWORD_HASH'], { input: `${encoded}\n` });
    if (result.code !== 0) throw new Error('Não foi possível cadastrar a credencial na Cloudflare. Confira o acesso e a implantação inicial.');
    console.log('Senha cadastrada no segredo privado da Cloudflare. Nenhuma senha ou hash foi exibido.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
