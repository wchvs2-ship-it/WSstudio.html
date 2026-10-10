import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { hashPassword } from '../backend/auth.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicOrigin = 'https://wchvs2-ship-it.github.io';
const workerOrigin = 'https://studio.example';
let bundleDirectory;
let bundlePath;
let workerConfig;

before(async () => {
  workerConfig = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
  bundleDirectory = await mkdtemp(join(tmpdir(), 'wsstudio-worker-bundle-'));
  bundlePath = join(bundleDirectory, 'worker.mjs');
  await build({
    entryPoints: [join(root, 'cloudflare/worker.mjs')],
    outfile: bundlePath,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    external: ['cloudflare:workers', 'node:*'],
    logLevel: 'silent'
  });
});

after(async () => {
  if (bundleDirectory) await rm(bundleDirectory, { recursive: true, force: true });
});

// Real files form the asset service; the Worker, Durable Object and SQLite all
// run in workerd. No authentication or persistence is replaced by test doubles.
async function assets(request) {
  const files = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/app.js': 'app.js',
    '/catalog.js': 'catalog.js',
    '/style.css': 'style.css',
    '/admin/': 'admin/index.html',
    '/admin/index.html': 'admin/index.html',
    '/admin/admin.js': 'admin/admin.js',
    '/admin/admin.css': 'admin/admin.css'
  };
  const file = files[new URL(request.url).pathname];
  if (!file) return new Response('Not found', { status: 404 });
  const body = await readFile(join(root, file));
  const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
  return new Response(body, { headers: { 'Content-Type': `${type}; charset=utf-8` } });
}

async function fixture(t) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'wsstudio-cloudflare-test-'));
  const password = randomBytes(24).toString('hex');
  const bindings = {
    ADMIN_USERNAME: 'test-admin',
    ADMIN_PASSWORD_HASH: hashPassword(password),
    ALLOWED_ORIGINS: publicOrigin
  };
  let runtime;
  function start() {
    runtime = new Miniflare(convertV4MiniflareOptions({
      name: 'wsstudio-cloudflare-test',
      modules: true,
      scriptPath: bundlePath,
      modulesRoot: bundleDirectory,
      compatibilityDate: workerConfig.compatibility_date,
      compatibilityFlags: workerConfig.compatibility_flags,
      durableObjects: { STUDIO_API: { className: 'StudioApi', useSQLite: true } },
      resourcePersistencePath: dataDirectory,
      serviceBindings: { ASSETS: assets },
      bindings
    }));
  }
  t.after(async () => {
    try { await runtime?.dispose(); }
    finally { await rm(dataDirectory, { recursive: true, force: true }); }
  });
  start();
  return {
    password,
    request: async (path, { body, rawBody, headers, origin = workerOrigin, ...options } = {}) => {
      const response = await runtime.dispatchFetch(`${origin}${path}`, {
        ...options,
        headers: {
          'CF-Connecting-IP': '192.0.2.10',
          ...((body === undefined && rawBody === undefined) ? {} : { 'Content-Type': 'application/json' }),
          ...headers
        },
        ...(body === undefined && rawBody === undefined ? {} : { body: rawBody ?? JSON.stringify(body) })
      });
      const raw = await response.text();
      let json;
      try { json = JSON.parse(raw); } catch {}
      return { response, status: response.status, raw, json };
    },
    restart: async updatedBindings => {
      await runtime.dispose();
      Object.assign(bindings, updatedBindings);
      start();
    }
  };
}

function order(overrides = {}) {
  return {
    serviceId: 'landing',
    name: 'Cliente de teste Cloudflare',
    email: 'cliente-cloudflare@example.com',
    business: 'Negócio de teste',
    goal: 'Apresentar os meus serviços e receber novos pedidos.',
    paymentMethod: 'Pix',
    maintenanceRequested: false,
    ...overrides
  };
}

function createOrder(api, body = order(), key = randomUUID(), options = {}) {
  return api.request('/api/orders', {
    method: 'POST',
    body,
    ...options,
    headers: { Origin: publicOrigin, 'Idempotency-Key': key, ...options.headers }
  });
}

async function login(api, password = api.password) {
  const result = await api.request('/api/admin/login', {
    method: 'POST',
    headers: { Origin: workerOrigin },
    body: { username: 'test-admin', password }
  });
  assert.equal(result.status, 200, result.raw);
  const setCookie = result.response.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-ws_session=/);
  for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) {
    assert.ok(setCookie.includes(attribute), `Missing cookie attribute ${attribute}`);
  }
  assert.match(result.json.csrfToken, /^[a-f\d]{64}$/);
  return { cookie: setCookie.split(';', 1)[0], csrf: result.json.csrfToken };
}

function adminRequest(api, session, path, options = {}) {
  return api.request(path, {
    ...options,
    headers: {
      Origin: workerOrigin,
      Cookie: session.cookie,
      'X-CSRF-Token': session.csrf,
      ...options.headers
    }
  });
}

test('Cloudflare runtime verifies the existing scrypt hash and keeps public receipts safe', async t => {
  const api = await fixture(t);
  assert.equal((await api.request('/api/health')).json.status, 'ok');
  const services = await api.request('/api/services');
  assert.equal(services.status, 200);
  assert.equal(services.json.services.length, 5);
  const created = await createOrder(api);
  assert.equal(created.status, 201, created.raw);
  assert.deepEqual(created.json.estimated, { minCents: 49090, maxCents: 59090 });
  assert.deepEqual(Object.keys(created.json).sort(), ['createdAt', 'estimated', 'id', 'serviceName']);
  assert.ok(!created.raw.includes(order().email));
  assert.equal(created.response.headers.get('Access-Control-Allow-Origin'), publicOrigin);
  assert.equal(created.response.headers.get('Cache-Control'), 'no-store');
  const poisonedPrice = await createOrder(api, order({ amountCents: 1 }));
  assert.equal(poisonedPrice.status, 400);
  assert.equal((await api.request('/api/admin/orders')).status, 401);
  const wrongPassword = await api.request('/api/admin/login', {
    method: 'POST', headers: { Origin: workerOrigin },
    body: { username: 'test-admin', password: randomBytes(24).toString('hex') }
  });
  assert.equal(wrongPassword.status, 401);
  const list = await adminRequest(api, await login(api), '/api/admin/orders');
  assert.equal(list.status, 200, list.raw);
  assert.equal(list.json.total, 1);
  assert.equal(list.json.orders[0].customer.email, order().email);
});

test('concurrent Worker requests share a single SQLite Durable Object idempotent order', async t => {
  const api = await fixture(t);
  const key = randomUUID();
  const attempts = await Promise.all(Array.from({ length: 6 }, () => createOrder(api, order(), key)));
  assert.equal(attempts.filter(attempt => attempt.status === 201).length, 1);
  assert.equal(attempts.filter(attempt => attempt.status === 200).length, 5);
  assert.equal(new Set(attempts.map(attempt => attempt.json?.id)).size, 1);
  for (const replay of attempts.filter(attempt => attempt.status === 200)) {
    assert.equal(replay.response.headers.get('Idempotency-Replayed'), 'true');
  }
  const changed = await createOrder(api, order({ business: 'Outra empresa' }), key);
  assert.equal(changed.status, 409);
  const list = await adminRequest(api, await login(api), '/api/admin/orders');
  assert.equal(list.json.total, 1);
});

test('HTTPS sessions, exact origins, CSRF and case-sensitive routes protect administration', async t => {
  const api = await fixture(t);
  const created = await createOrder(api);
  const session = await login(api);
  const path = `/api/admin/orders/${created.json.id}`;
  const crossOrigin = await adminRequest(api, session, path, {
    method: 'PATCH', body: { action: 'quote', amountCents: 49090 },
    headers: { Origin: publicOrigin }
  });
  assert.equal(crossOrigin.status, 403);
  const withoutCsrf = await adminRequest(api, session, path, {
    method: 'PATCH', body: { action: 'quote', amountCents: 49090 },
    headers: { 'X-CSRF-Token': '' }
  });
  assert.equal(withoutCsrf.status, 403);
  const badCsrf = await adminRequest(api, session, path, {
    method: 'PATCH', body: { action: 'quote', amountCents: 49090 },
    headers: { 'X-CSRF-Token': randomBytes(32).toString('hex') }
  });
  assert.equal(badCsrf.status, 403);
  for (const casePath of ['/API/admin/login', '/api/Admin/login', '/api/admin/LOGIN']) {
    const result = await api.request(casePath, {
      method: 'POST', headers: { Origin: workerOrigin },
      body: { username: 'test-admin', password: api.password }
    });
    assert.equal(result.status, 404, casePath);
    assert.equal(result.response.headers.get('set-cookie'), null);
  }
  const insecure = await api.request('/api/admin/login', {
    origin: 'http://studio.example', method: 'POST',
    headers: { Origin: 'http://studio.example' },
    body: { username: 'test-admin', password: api.password }
  });
  assert.equal(insecure.status, 403);
  const insecurePage = await api.request('/admin/', {
    origin: 'http://studio.example', redirect: 'manual'
  });
  assert.equal(insecurePage.status, 308);
  assert.equal(insecurePage.response.headers.get('Location'), `${workerOrigin}/admin/`);
  const insecureHead = await api.request('/admin/', {
    origin: 'http://studio.example', method: 'HEAD', redirect: 'manual'
  });
  assert.equal(insecureHead.status, 308);
  assert.equal(insecureHead.response.headers.get('Location'), `${workerOrigin}/admin/`);
  assert.equal(insecureHead.raw, '');
  const localPage = await api.request('/admin/', {
    origin: 'http://127.0.0.1', redirect: 'manual'
  });
  assert.equal(localPage.status, 200);
  assert.match(localPage.raw, /<title>Pedidos · WSstudio<\/title>/);
  const list = await adminRequest(api, session, '/api/admin/orders');
  assert.equal(list.json.orders[0].status, 'new');
  const logout = await adminRequest(api, session, '/api/admin/logout', { method: 'POST' });
  assert.equal(logout.status, 204);
  assert.equal((await adminRequest(api, session, '/api/admin/session')).status, 401);
});

test('manual Pix rejects stale amounts, preserves odd cents and prevents duplicate confirmations', async t => {
  const api = await fixture(t);
  const created = await createOrder(api);
  const session = await login(api);
  const path = `/api/admin/orders/${created.json.id}`;
  const change = body => adminRequest(api, session, path, { method: 'PATCH', body });
  const quoted = await change({ action: 'quote', amountCents: 49091 });
  assert.equal(quoted.status, 200, quoted.raw);
  assert.equal(quoted.json.order.quote.depositCents, 24546);
  assert.equal(quoted.json.order.quote.balanceCents, 24545);
  const revised = await change({ action: 'quote', amountCents: 59091 });
  assert.equal(revised.status, 200, revised.raw);
  const stale = await change({ action: 'deposit', expectedAmountCents: 24546, reference: 'Teste, proposta antiga' });
  assert.equal(stale.status, 409);
  const unchanged = (await adminRequest(api, session, '/api/admin/orders')).json.orders[0];
  assert.equal(unchanged.status, 'quoted');
  assert.equal(unchanged.payments.deposit, null);
  assert.deepEqual(unchanged.history.map(event => event.action), ['created', 'quote', 'quote']);
  const prematureBalance = await change({ action: 'balance', expectedAmountCents: 29545, reference: 'Teste fora de ordem' });
  assert.equal(prematureBalance.status, 409);
  const depositBody = { action: 'deposit', expectedAmountCents: 29546, reference: 'Teste de entrada manual' };
  const deposit = await change(depositBody);
  assert.equal(deposit.status, 200, deposit.raw);
  assert.equal(deposit.json.order.status, 'in_progress');
  assert.equal((await change(depositBody)).status, 409);
  assert.equal((await change({ action: 'deliver' })).status, 200);
  const balanceBody = { action: 'balance', expectedAmountCents: 29545, reference: 'Teste de saldo manual' };
  const balance = await change(balanceBody);
  assert.equal(balance.status, 200, balance.raw);
  assert.equal(balance.json.order.status, 'completed');
  assert.equal(balance.json.order.quote.depositCents + balance.json.order.quote.balanceCents, 59091);
  assert.equal((await change(balanceBody)).status, 409);
  const complete = (await adminRequest(api, session, '/api/admin/orders')).json.orders[0];
  assert.deepEqual(complete.history.map(event => event.action), ['created', 'quote', 'quote', 'deposit', 'deliver', 'balance']);
});

test('Durable Object data and sessions survive restart and secret rotation revokes previous sessions', async t => {
  const api = await fixture(t);
  const key = randomUUID();
  const created = await createOrder(api, order(), key);
  const session = await login(api);
  await api.restart();
  const persisted = await adminRequest(api, session, '/api/admin/orders');
  assert.equal(persisted.status, 200, persisted.raw);
  assert.equal(persisted.json.total, 1);
  assert.equal(persisted.json.orders[0].id, created.json.id);
  const replay = await createOrder(api, order(), key);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, created.json.id);
  const newPassword = randomBytes(24).toString('hex');
  await api.restart({ ADMIN_PASSWORD_HASH: hashPassword(newPassword) });
  assert.equal((await adminRequest(api, session, '/api/admin/orders')).status, 401);
  const oldLogin = await api.request('/api/admin/login', {
    method: 'POST', headers: { Origin: workerOrigin },
    body: { username: 'test-admin', password: api.password }
  });
  assert.equal(oldLogin.status, 401);
  const newSession = await login(api, newPassword);
  const stillPersisted = await adminRequest(api, newSession, '/api/admin/orders');
  assert.equal(stillPersisted.json.orders[0].id, created.json.id);
});

test('Worker bounds incoming bodies and only serves public assets and exact CORS origins', async t => {
  const api = await fixture(t);
  const allowedPreflight = await api.request('/api/orders', {
    method: 'OPTIONS', headers: {
      Origin: publicOrigin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type, Idempotency-Key'
    }
  });
  assert.equal(allowedPreflight.status, 204);
  assert.equal(allowedPreflight.response.headers.get('Access-Control-Allow-Origin'), publicOrigin);
  assert.equal(allowedPreflight.response.headers.get('Access-Control-Allow-Credentials'), null);
  const forbidden = await createOrder(api, order(), randomUUID(), {
    headers: { Origin: `${publicOrigin}.evil.example` }
  });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.response.headers.get('Access-Control-Allow-Origin'), null);
  const oversize = await api.request('/api/orders', {
    method: 'POST', headers: { Origin: publicOrigin, 'Idempotency-Key': randomUUID() },
    rawBody: JSON.stringify(order({ goal: 'x'.repeat(20_000) }))
  });
  assert.equal(oversize.status, 413);
  const streamed = await api.request('/api/orders', {
    method: 'POST', headers: { Origin: publicOrigin, 'Idempotency-Key': randomUUID() },
    rawBody: new ReadableStream({
      start(controller) {
        for (let index = 0; index < 6; index++) controller.enqueue(new TextEncoder().encode('x'.repeat(4096)));
        controller.close();
      }
    }),
    duplex: 'half'
  });
  assert.equal(streamed.status, 413);
  for (const path of ['/.git/config', '/.env', '/.dev.vars', '/.data/studio.sqlite', '/backend/auth.mjs', '/cloudflare/worker.mjs']) {
    assert.equal((await api.request(path)).status, 404, `Private file exposed: ${path}`);
  }
  const config = await api.request('/api-config.js');
  assert.equal(config.status, 200);
  assert.match(config.raw, /enabled\s*:\s*true/);
  const redirect = await api.request('/admin', { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.response.headers.get('Location'), '/admin/');
  assert.equal((await api.request('/admin/')).status, 200);
  const list = await adminRequest(api, await login(api), '/api/admin/orders');
  assert.equal(list.json.total, 0);
});

test('abuse limits persist across runtime restart and isolate clients without losing valid orders', async t => {
  const api = await fixture(t);
  const firstClient = { headers: { 'CF-Connecting-IP': '192.0.2.20' } };
  for (let index = 0; index < 15; index++) {
    const created = await createOrder(api, order({ business: `Teste ${index}` }), randomUUID(), firstClient);
    assert.equal(created.status, 201, created.raw);
  }
  const blocked = await createOrder(api, order(), randomUUID(), firstClient);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.response.headers.get('Retry-After')) > 0);
  await api.restart();
  assert.equal((await createOrder(api, order(), randomUUID(), firstClient)).status, 429);
  const otherClient = await createOrder(api, order(), randomUUID(), { headers: { 'CF-Connecting-IP': '192.0.2.21' } });
  assert.equal(otherClient.status, 201, otherClient.raw);
  const list = await adminRequest(api, await login(api), '/api/admin/orders');
  assert.equal(list.json.total, 16);
});
