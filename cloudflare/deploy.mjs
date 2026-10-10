import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAssets } from './build.mjs';
import { runWrangler } from './cli.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowedOrigin = 'https://wchvs2-ship-it.github.io';

function findWorkerUrl(output) {
  const candidates = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/gi) ?? [];
  for (const candidate of candidates.reverse()) {
    const url = new URL(candidate);
    // Não faça verificações em endereços arbitrários retirados de logs.
    if (/^wsstudio-api\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.workers\.dev$/i.test(url.hostname)
        && url.protocol === 'https:' && !url.port && !url.username && !url.password) {
      return url.origin;
    }
  }
  throw new Error('O deploy terminou, mas a URL workers.dev não foi encontrada. Confira a URL no painel da Cloudflare e verifique a API antes de conectar o site.');
}

async function request(baseUrl, path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    redirect: 'error',
    ...options,
    signal: AbortSignal.timeout(20_000),
  });
}

async function verifyDeployment(baseUrl) {
  const health = await request(baseUrl, '/api/health');
  assert.equal(health.status, 200, 'A API não respondeu ao teste de saúde.');
  assert.equal((await health.json()).status, 'ok', 'Resposta de saúde inesperada.');

  const servicesResponse = await request(baseUrl, '/api/services');
  assert.equal(servicesResponse.status, 200, 'O catálogo não respondeu.');
  const { services } = await servicesResponse.json();
  assert.equal(services?.length, 5, 'O catálogo de serviços está incompleto.');

  const session = await request(baseUrl, '/api/admin/session');
  assert.equal(session.status, 401, 'O painel precisa exigir autenticação.');
  for (const path of ['/.env', '/backend/server.mjs', '/.data/orders.sqlite']) {
    const response = await request(baseUrl, path);
    assert.equal(response.status, 404, `O caminho privado ${path} precisa estar bloqueado.`);
  }

  const preflightHeaders = {
    Origin: allowedOrigin,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,idempotency-key',
  };
  const preflight = await request(baseUrl, '/api/orders', {
    method: 'OPTIONS', headers: preflightHeaders,
  });
  assert.equal(preflight.status, 204, 'O site público não recebeu permissão para enviar pedidos.');
  assert.equal(preflight.headers.get('access-control-allow-origin'), allowedOrigin);
  const rejectedOrigin = await request(baseUrl, '/api/orders', {
    method: 'OPTIONS',
    headers: { ...preflightHeaders, Origin: 'https://origem-invalida.example' },
  });
  assert.equal(rejectedOrigin.status, 403, 'Uma origem não autorizada recebeu acesso.');
}

try {
  const args = process.argv.slice(2);
  const dryRun = args.length === 1 && args[0] === '--dry-run';
  if (args.length > 0 && !dryRun) {
    throw new Error('Use npm run cloud:deploy ou npm run cloud:check.');
  }
  await buildAssets();
  const result = await runWrangler(dryRun ? ['deploy', '--dry-run'] : ['deploy'], { capture: true });
  if (result.code !== 0) {
    throw new Error(`Wrangler encerrou com código ${result.code}. A conexão do site não foi alterada.`);
  }
  if (dryRun) {
    process.stdout.write('Compilação do Worker validada sem publicação.\n');
    process.exit(0);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const baseUrl = findWorkerUrl(output);
  await verifyDeployment(baseUrl);
  const generatedDirectory = join(projectRoot, '.cloudflare');
  await mkdir(generatedDirectory, { recursive: true });
  await writeFile(join(generatedDirectory, 'deployment.json'), `${JSON.stringify({
    baseUrl,
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  process.stdout.write(`API publicada e verificada: ${baseUrl}\n`);
  process.stdout.write('Conecte esta URL em api-config.js; o site do GitHub Pages ainda não foi alterado.\n');
} catch (error) {
  process.stderr.write(`Falha na publicação/verificação: ${error.message}\n`);
  process.exitCode = 1;
}
