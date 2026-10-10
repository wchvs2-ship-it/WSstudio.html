import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../backend/app.mjs';
import { hashPassword, verifyPassword } from '../backend/auth.mjs';

const password = 'Local-Test-Password-2026!';
const publicOrigin = 'https://wchvs2-ship-it.github.io';

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'wsstudio-api-test-'));
  const options = {
    dataDir,
    adminUsername: 'studio-admin',
    adminPasswordHash: await hashPassword(password),
    allowedOrigins: [publicOrigin],
    ...overrides
  };
  let instance;
  let server;
  let base;
  async function stop() {
    if (!server) return;
    const currentServer = server;
    server = null;
    await new Promise((resolve, reject) => currentServer.close(error => error ? reject(error) : resolve()));
    await instance.close();
  }
  async function start() {
    instance = await createApp(options);
    server = createServer(instance.app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  await start();
  t.after(async () => {
    await stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  const request = async (path, { body, headers, ...options } = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const raw = await response.text();
    let json;
    try { json = JSON.parse(raw); } catch {}
    return { response, json, raw, status: response.status };
  };
  return {
    request,
    get base() { return base; },
    restart: async (updatedOptions = {}) => {
      await stop();
      Object.assign(options, updatedOptions);
      await start();
    }
  };
}

function order(overrides = {}) {
  return {
    serviceId: 'landing',
    name: 'Cliente de Teste',
    email: 'cliente@example.com',
    business: 'Negócio de teste',
    goal: 'Apresentar meus serviços e receber novos pedidos.',
    paymentMethod: 'Pix',
    maintenanceRequested: false,
    ...overrides
  };
}

async function createOrder(api, body = order(), key = randomUUID(), origin = publicOrigin) {
  return api.request('/api/orders', {
    method: 'POST',
    headers: { Origin: origin, 'Idempotency-Key': key },
    body
  });
}

async function login(api) {
  const result = await api.request('/api/admin/login', {
    method: 'POST',
    headers: { Origin: api.base },
    body: { username: 'studio-admin', password }
  });
  assert.equal(result.status, 200, result.raw);
  const setCookie = result.response.headers.get('set-cookie');
  assert.ok(setCookie?.includes('HttpOnly'));
  assert.match(setCookie, /SameSite=Strict/i);
  assert.ok(result.json.csrfToken);
  return { cookie: setCookie.split(';', 1)[0], csrf: result.json.csrfToken };
}

async function adminRequest(api, session, path, options = {}) {
  return api.request(path, {
    ...options,
    headers: {
      Origin: api.base,
      Cookie: session.cookie,
      'X-CSRF-Token': session.csrf,
      ...options.headers
    }
  });
}

test('password hashes verify credentials without storing plaintext', async () => {
  const hash = await hashPassword(password);
  assert.match(hash, /^scrypt\$[a-f0-9]+\$[a-f0-9]+$/i);
  assert.ok(!hash.includes(password));
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('incorrect-password', hash), false);
  assert.equal(await verifyPassword(password, 'invalid-hash'), false);
});

test('health, service catalog and explicit static files work without exposing server files', async t => {
  const api = await fixture(t);
  const health = await api.request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'ok');
  const services = await api.request('/api/services');
  assert.equal(services.status, 200);
  assert.deepEqual(services.json.services.map(service => service.id).sort(), ['blog', 'cardapio', 'institucional', 'landing', 'loja']);
  const config = await api.request('/api-config.js');
  assert.equal(config.status, 200);
  assert.match(config.raw, /enabled\s*:\s*true/);
  const homepage = await api.request('/');
  assert.equal(homepage.status, 200);
  assert.match(homepage.raw, /WSstudio/);
  const adminRedirect = await api.request('/admin', { redirect: 'manual' });
  assert.equal(adminRedirect.status, 302);
  assert.equal(adminRedirect.response.headers.get('location'), '/admin/');
  const adminPage = await api.request('/admin/', { redirect: 'manual' });
  assert.equal(adminPage.status, 200);
  assert.match(adminPage.raw, /<title>Pedidos · WSstudio<\/title>/);
  const followedAdminRedirect = await api.request('/admin');
  assert.equal(followedAdminRedirect.status, 200);
  assert.equal(followedAdminRedirect.response.url, `${api.base}/admin/`);
  assert.equal(followedAdminRedirect.raw, adminPage.raw);
  for (const path of ['/.git/config', '/.data/orders.sqlite', '/backend/app.mjs', '/test/backend.test.mjs', '/docs/backend.md']) {
    const result = await api.request(path);
    assert.equal(result.status, 404, `Server file exposed at ${path}`);
  }
});

test('public orders preserve server prices and return only a safe receipt', async t => {
  const api = await fixture(t);
  const result = await createOrder(api);
  assert.equal(result.status, 201, result.raw);
  assert.match(result.json.id, /^[0-9a-f-]{36}$/i);
  assert.ok(!Number.isNaN(Date.parse(result.json.createdAt)));
  assert.equal(result.json.serviceName, 'Landing page comum');
  assert.deepEqual(result.json.estimated, { minCents: 49090, maxCents: 59090 });
  assert.deepEqual(Object.keys(result.json).sort(), ['createdAt', 'estimated', 'id', 'serviceName']);
  assert.ok(!result.raw.includes('cliente@example.com'));
  assert.equal(result.response.headers.get('access-control-allow-origin'), publicOrigin);
  const admin = await login(api);
  const list = await adminRequest(api, admin, '/api/admin/orders');
  assert.equal(list.status, 200, list.raw);
  assert.equal(list.json.total, 1);
  assert.equal(list.json.orders[0].customer.email, 'cliente@example.com');
  assert.equal(list.json.orders[0].status, 'new');
});

test('invalid input, extra price fields, missing idempotency and unapproved origins cannot create orders', async t => {
  const api = await fixture(t);
  for (const invalid of [
    { email: 'invalid' },
    { name: '' },
    { serviceId: 'unknown' },
    { paymentMethod: 'unsupported' },
    { goal: 'x'.repeat(2001) },
    { maintenanceRequested: 'false' },
    { amountCents: 1 },
    { status: 'completed' }
  ]) {
    const result = await createOrder(api, order(invalid));
    assert.equal(result.status, 400, JSON.stringify(invalid));
  }
  const noKey = await api.request('/api/orders', {
    method: 'POST', headers: { Origin: publicOrigin }, body: order()
  });
  assert.equal(noKey.status, 400);
  const invalidKey = await createOrder(api, order(), 'not-a-uuid');
  assert.equal(invalidKey.status, 400);
  const externalOrigin = await createOrder(api, order(), randomUUID(), 'https://untrusted.example');
  assert.equal(externalOrigin.status, 403);
  const similarOrigin = await createOrder(api, order(), randomUUID(), `${publicOrigin}.evil.example`);
  assert.equal(similarOrigin.status, 403);
  const oversize = await createOrder(api, order({ goal: 'x'.repeat(100000) }));
  assert.equal(oversize.status, 413);
  const list = await adminRequest(api, await login(api), '/api/admin/orders');
  assert.equal(list.json.total, 0);
});

test('idempotency prevents duplicated concurrent orders and rejects changed requests', async t => {
  const api = await fixture(t);
  const key = randomUUID();
  const attempts = await Promise.all(Array.from({ length: 5 }, () => createOrder(api, order(), key)));
  assert.equal(attempts.filter(result => result.status === 201).length, 1);
  assert.equal(attempts.filter(result => result.status === 200).length, 4);
  assert.equal(new Set(attempts.map(result => result.json.id)).size, 1);
  for (const result of attempts.filter(result => result.status === 200)) {
    assert.equal(result.response.headers.get('Idempotency-Replayed'), 'true');
  }
  const changed = await createOrder(api, order({ business: 'Outra empresa' }), key);
  assert.equal(changed.status, 409);
  const list = await adminRequest(api, await login(api), '/api/admin/orders');
  assert.equal(list.json.total, 1);
});

test('admin requires configured credentials, valid password, same-origin requests and CSRF', async t => {
  const unconfigured = await fixture(t, { adminPasswordHash: undefined });
  const unavailable = await unconfigured.request('/api/admin/login', {
    method: 'POST', headers: { Origin: unconfigured.base },
    body: { username: 'studio-admin', password }
  });
  assert.equal(unavailable.status, 503);
  const api = await fixture(t);
  const unauthorized = await api.request('/api/admin/orders');
  assert.equal(unauthorized.status, 401);
  const wrong = await api.request('/api/admin/login', {
    method: 'POST', headers: { Origin: api.base },
    body: { username: 'studio-admin', password: 'Wrong-Password-123!' }
  });
  assert.equal(wrong.status, 401);
  const wrongOrigin = await api.request('/api/admin/login', {
    method: 'POST', headers: { Origin: publicOrigin },
    body: { username: 'studio-admin', password }
  });
  assert.equal(wrongOrigin.status, 403);
  const session = await login(api);
  const info = await adminRequest(api, session, '/api/admin/session');
  assert.equal(info.status, 200);
  assert.equal(info.json.username, 'studio-admin');
  assert.equal(info.json.csrfToken, session.csrf);
  const created = await createOrder(api);
  const path = `/api/admin/orders/${created.json.id}`;
  const noCsrf = await api.request(path, {
    method: 'PATCH', headers: { Origin: api.base, Cookie: session.cookie }, body: { action: 'cancel' }
  });
  assert.equal(noCsrf.status, 403);
  const wrongCsrf = await adminRequest(api, session, path, {
    method: 'PATCH', headers: { 'X-CSRF-Token': 'incorrect-token' }, body: { action: 'cancel' }
  });
  assert.equal(wrongCsrf.status, 403);
  const externalMutation = await adminRequest(api, session, path, {
    method: 'PATCH', headers: { Origin: publicOrigin }, body: { action: 'cancel' }
  });
  assert.equal(externalMutation.status, 403);
});

test('manual Pix workflow records 50/50 quote, both confirmations and an ordered audit trail', async t => {
  const api = await fixture(t);
  const created = await createOrder(api);
  const session = await login(api);
  const path = `/api/admin/orders/${created.json.id}`;
  const change = body => adminRequest(api, session, path, { method: 'PATCH', body });
  const quoted = await change({ action: 'quote', amountCents: 49101, notes: 'Inclui domínio e hospedagem por um ano.' });
  assert.equal(quoted.status, 200, quoted.raw);
  assert.equal(quoted.json.order.status, 'quoted');
  const quote = quoted.json.order.quote;
  assert.equal(quote.amountCents, 49101);
  assert.equal(quote.depositCents + quote.balanceCents, 49101);
  assert.ok(Math.abs(quote.depositCents - quote.balanceCents) <= 1);
  const deposit = await change({ action: 'deposit', expectedAmountCents: quote.depositCents, reference: 'Pix teste entrada 001' });
  assert.equal(deposit.status, 200, deposit.raw);
  assert.equal(deposit.json.order.status, 'in_progress');
  assert.equal(deposit.json.order.payments.deposit.reference, 'Pix teste entrada 001');
  assert.equal(deposit.json.order.payments.balance, null);
  const delivered = await change({ action: 'deliver', notes: 'Cliente recebeu o link e os arquivos.' });
  assert.equal(delivered.status, 200, delivered.raw);
  assert.equal(delivered.json.order.status, 'delivered');
  const balance = await change({ action: 'balance', expectedAmountCents: quote.balanceCents, reference: 'Pix teste quitação 002' });
  assert.equal(balance.status, 200, balance.raw);
  assert.equal(balance.json.order.status, 'completed');
  assert.equal(balance.json.order.payments.balance.reference, 'Pix teste quitação 002');
  assert.deepEqual(balance.json.order.history.map(event => event.action), ['created', 'quote', 'deposit', 'deliver', 'balance']);
  assert.ok(balance.json.order.history.every(event => !Number.isNaN(Date.parse(event.at))));
  const secondBalance = await change({ action: 'balance', expectedAmountCents: quote.balanceCents, reference: 'Duplicated Pix' });
  assert.equal(secondBalance.status, 409);
});

test('illegal and concurrent transitions cannot double-confirm payments or alter agreed prices', async t => {
  const api = await fixture(t);
  const created = await createOrder(api);
  const session = await login(api);
  const path = `/api/admin/orders/${created.json.id}`;
  const change = body => adminRequest(api, session, path, { method: 'PATCH', body });
  for (const action of ['deposit', 'deliver', 'balance']) {
    const result = await change({ action, ...(action === 'deliver' ? {} : { expectedAmountCents: 1, reference: 'Antes do orçamento' }) });
    assert.equal(result.status, 409, action);
  }
  for (const amountCents of [0, 1, -1, 49.5, 100000001]) {
    const invalidQuote = await change({ action: 'quote', amountCents });
    assert.equal(invalidQuote.status, 400, `Invalid quote ${amountCents}`);
    if (amountCents === 1) assert.match(invalidQuote.json.error, /R\$ 0,02/);
  }
  assert.equal((await change({ action: 'quote', amountCents: 59090 })).status, 200);
  const results = await Promise.all([
    change({ action: 'deposit', expectedAmountCents: 29545, reference: 'Recebimento A' }),
    change({ action: 'deposit', expectedAmountCents: 29545, reference: 'Recebimento B' })
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const invalidRequote = await change({ action: 'quote', amountCents: 1 });
  assert.equal(invalidRequote.status, 409);
  assert.equal((await change({ action: 'balance', expectedAmountCents: 29545, reference: 'Antes da entrega' })).status, 409);
  assert.equal((await change({ action: 'cancel' })).status, 409);
  const list = await adminRequest(api, session, '/api/admin/orders');
  assert.equal(list.json.orders[0].quote.amountCents, 59090);
  assert.equal(list.json.orders[0].history.filter(event => event.action === 'deposit').length, 1);
});

test('cancelled orders remain auditable and cannot receive payment confirmations', async t => {
  const api = await fixture(t);
  const created = await createOrder(api);
  const session = await login(api);
  const path = `/api/admin/orders/${created.json.id}`;
  const cancel = await adminRequest(api, session, path, {
    method: 'PATCH', body: { action: 'cancel', notes: 'Cliente desistiu antes de contratar.' }
  });
  assert.equal(cancel.status, 200, cancel.raw);
  assert.equal(cancel.json.order.status, 'cancelled');
  assert.deepEqual(cancel.json.order.history.map(event => event.action), ['created', 'cancel']);
  const deposit = await adminRequest(api, session, path, {
    method: 'PATCH', body: { action: 'deposit', expectedAmountCents: 1, reference: 'Recebimento posterior' }
  });
  assert.equal(deposit.status, 409);
});

test('pagination is bounded and order state plus idempotency survive a server restart', async t => {
  const api = await fixture(t);
  const key = randomUUID();
  const first = await createOrder(api, order(), key);
  await createOrder(api, order({ name: 'Segundo cliente', serviceId: 'blog' }));
  const session = await login(api);
  const quoted = await adminRequest(api, session, `/api/admin/orders/${first.json.id}`, {
    method: 'PATCH', body: { action: 'quote', amountCents: 59090 }
  });
  assert.equal(quoted.status, 200);
  const page = await adminRequest(api, session, '/api/admin/orders?page=1&limit=1');
  assert.equal(page.status, 200);
  assert.equal(page.json.total, 2);
  assert.equal(page.json.page, 1);
  assert.equal(page.json.limit, 1);
  assert.equal(page.json.orders.length, 1);
  const nextPage = await adminRequest(api, session, '/api/admin/orders?page=2&limit=1');
  assert.notEqual(nextPage.json.orders[0].id, page.json.orders[0].id);
  const invalidPage = await adminRequest(api, session, '/api/admin/orders?page=0&limit=100000');
  assert.equal(invalidPage.status, 400);
  await api.restart();
  const replay = await createOrder(api, order(), key);
  assert.equal(replay.status, 200, replay.raw);
  assert.equal(replay.json.id, first.json.id);
  assert.equal(replay.response.headers.get('Idempotency-Replayed'), 'true');
  const list = await adminRequest(api, await login(api), '/api/admin/orders');
  assert.equal(list.json.total, 2);
  const restored = list.json.orders.find(item => item.id === first.json.id);
  assert.equal(restored.status, 'quoted');
  assert.equal(restored.quote.amountCents, 59090);
  assert.deepEqual(restored.history.map(event => event.action), ['created', 'quote']);
});

test('public order and admin login limits return retry instructions without accepting excess requests', async t => {
  const api = await fixture(t, {
    rateLimits: { orders: { max: 1, windowMs: 60000 }, login: { max: 1, windowMs: 60000 } }
  });
  assert.equal((await createOrder(api)).status, 201);
  const limitedOrder = await createOrder(api);
  assert.equal(limitedOrder.status, 429);
  assert.ok(Number(limitedOrder.response.headers.get('Retry-After')) > 0);
  const invalidLogin = await api.request('/api/admin/login', {
    method: 'POST', headers: { Origin: api.base },
    body: { username: 'studio-admin', password: 'Wrong-Password-123!' }
  });
  assert.equal(invalidLogin.status, 401);
  const limitedLogin = await api.request('/api/admin/login', {
    method: 'POST', headers: { Origin: api.base },
    body: { username: 'studio-admin', password }
  });
  assert.equal(limitedLogin.status, 429);
  assert.ok(Number(limitedLogin.response.headers.get('Retry-After')) > 0);
  assert.equal(limitedLogin.response.headers.get('set-cookie'), null);
});

test('logout invalidates the session and cannot be initiated without a CSRF token', async t => {
  const api = await fixture(t);
  const session = await login(api);
  const missingCsrf = await api.request('/api/admin/logout', {
    method: 'POST', headers: { Origin: api.base, Cookie: session.cookie }
  });
  assert.equal(missingCsrf.status, 403);
  const logout = await adminRequest(api, session, '/api/admin/logout', { method: 'POST' });
  assert.equal(logout.status, 204);
  const expired = await adminRequest(api, session, '/api/admin/orders');
  assert.equal(expired.status, 401);
});

test('production admin rejects plain HTTP and only trusts HTTPS forwarded by a configured proxy', async t => {
  const direct = await fixture(t, { production: true });
  const httpLogin = await direct.request('/api/admin/login', {
    method: 'POST', headers: { Origin: direct.base },
    body: { username: 'studio-admin', password }
  });
  assert.equal(httpLogin.status, 403);
  assert.equal(httpLogin.response.headers.get('set-cookie'), null);
  const fakeHttps = await direct.request('/api/admin/login', {
    method: 'POST', headers: { 'X-Forwarded-Proto': 'https' },
    body: { username: 'studio-admin', password }
  });
  assert.equal(fakeHttps.status, 403);
  const proxied = await fixture(t, { production: true, trustProxy: 1 });
  const httpsOrigin = proxied.base.replace(/^http:/, 'https:');
  const httpsLogin = await proxied.request('/api/admin/login', {
    method: 'POST', headers: { Origin: httpsOrigin, 'X-Forwarded-Proto': 'https' },
    body: { username: 'studio-admin', password }
  });
  assert.equal(httpsLogin.status, 200, httpsLogin.raw);
  const setCookie = httpsLogin.response.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-ws_session=/);
  assert.match(setCookie, /;\s*Secure(?:;|$)/i);
  assert.match(setCookie, /;\s*HttpOnly(?:;|$)/i);
  assert.match(setCookie, /;\s*SameSite=Strict(?:;|$)/i);
  assert.match(setCookie, /;\s*Path=\/(?:;|$)/i);
  assert.doesNotMatch(setCookie, /;\s*Domain=/i);
  assert.match(httpsLogin.response.headers.get('strict-transport-security'), /max-age=\d+/);
  const session = await proxied.request('/api/admin/session', {
    headers: { Origin: httpsOrigin, 'X-Forwarded-Proto': 'https', Cookie: setCookie.split(';', 1)[0] }
  });
  assert.equal(session.status, 200, session.raw);
  assert.equal(session.json.username, 'studio-admin');
});

test('different route capitalization never runs admin authentication or exposes a session', async t => {
  for (const production of [false, true]) {
    const api = await fixture(t, { production });
    const session = production ? null : await login(api);
    for (const path of ['/api/ADMIN/login', '/API/admin/login', '/api/Admin/session']) {
      const isLogin = path.endsWith('/login');
      const result = await api.request(path, {
        method: isLogin ? 'POST' : 'GET',
        headers: {
          ...(path.startsWith('/API') ? {} : { Origin: api.base }),
          ...(session ? { Cookie: session.cookie } : {})
        },
        ...(isLogin ? { body: { username: 'studio-admin', password } } : {})
      });
      assert.equal(result.status, 404, `${production ? 'production' : 'development'} ${path}`);
      assert.equal(result.response.headers.get('set-cookie'), null);
      assert.equal(result.json?.csrfToken, undefined);
      assert.equal(result.json?.username, undefined);
    }
    if (production) {
      const protectedLogin = await api.request('/api/admin/login', {
        method: 'POST', headers: { Origin: api.base },
        body: { username: 'studio-admin', password }
      });
      assert.equal(protectedLogin.status, 403);
      assert.equal(protectedLogin.response.headers.get('set-cookie'), null);
    }
  }
});

test('changing administrator credentials revokes prior sessions after restart while preserving orders', async t => {
  const api = await fixture(t);
  const created = await createOrder(api);
  const oldSession = await login(api);
  const replacementPassword = 'Replacement-Test-Password-2026!';
  await api.restart({ adminPasswordHash: await hashPassword(replacementPassword) });
  const revoked = await adminRequest(api, oldSession, '/api/admin/orders');
  assert.equal(revoked.status, 401);
  const oldPassword = await api.request('/api/admin/login', {
    method: 'POST', headers: { Origin: api.base },
    body: { username: 'studio-admin', password }
  });
  assert.equal(oldPassword.status, 401);
  const replacement = await api.request('/api/admin/login', {
    method: 'POST', headers: { Origin: api.base },
    body: { username: 'studio-admin', password: replacementPassword }
  });
  assert.equal(replacement.status, 200, replacement.raw);
  const list = await adminRequest(api, {
    cookie: replacement.response.headers.get('set-cookie').split(';', 1)[0],
    csrf: replacement.json.csrfToken
  }, '/api/admin/orders');
  assert.equal(list.status, 200);
  assert.equal(list.json.total, 1);
  assert.equal(list.json.orders[0].id, created.json.id);
});

test('prototype property names cannot act as order mutations', async t => {
  const api = await fixture(t);
  const created = await createOrder(api);
  const session = await login(api);
  const before = await adminRequest(api, session, '/api/admin/orders');
  for (const action of ['__proto__', 'toString', 'constructor']) {
    const result = await adminRequest(api, session, `/api/admin/orders/${created.json.id}`, {
      method: 'PATCH', body: { action }
    });
    assert.equal(result.status, 400, action);
  }
  const after = await adminRequest(api, session, '/api/admin/orders');
  assert.deepEqual(after.json.orders, before.json.orders);
});

test('payment confirmations reject missing or invalid expected amounts without changing financial state', async t => {
  const api = await fixture(t);
  const created = await createOrder(api);
  const session = await login(api);
  const path = `/api/admin/orders/${created.json.id}`;
  const change = body => adminRequest(api, session, path, { method: 'PATCH', body });
  const quoted = await change({ action: 'quote', amountCents: 49101 });
  assert.equal(quoted.status, 200);
  for (const action of ['quote', 'deliver', 'cancel']) {
    const body = { action, expectedAmountCents: 24551, ...(action === 'quote' ? { amountCents: 49101 } : {}) };
    assert.equal((await change(body)).status, 400, `${action} must reject payment-specific fields`);
  }
  for (const expectedAmountCents of [undefined, 0, -1, 1.5, '24551', null]) {
    const invalid = await change({ action: 'deposit', expectedAmountCents, reference: 'Entrada inválida' });
    assert.equal(invalid.status, 400, `Invalid expected amount ${expectedAmountCents}`);
  }
  const beforeDeposit = await adminRequest(api, session, '/api/admin/orders');
  assert.equal(beforeDeposit.json.orders[0].status, 'quoted');
  assert.equal(beforeDeposit.json.orders[0].payments.deposit, null);
  assert.deepEqual(beforeDeposit.json.orders[0].history.map(event => event.action), ['created', 'quote']);
  assert.equal((await change({ action: 'deposit', expectedAmountCents: 24551, reference: 'Entrada correta' })).status, 200);
  assert.equal((await change({ action: 'deliver' })).status, 200);
  assert.equal((await change({ action: 'balance', reference: 'Sem valor confirmado' })).status, 400);
  assert.equal((await change({ action: 'balance', expectedAmountCents: 24551, reference: 'Saldo incorreto' })).status, 409);
  const beforeBalance = await adminRequest(api, session, '/api/admin/orders');
  assert.equal(beforeBalance.json.orders[0].status, 'delivered');
  assert.equal(beforeBalance.json.orders[0].payments.balance, null);
  assert.deepEqual(beforeBalance.json.orders[0].history.map(event => event.action), ['created', 'quote', 'deposit', 'deliver']);
  assert.equal((await change({ action: 'balance', expectedAmountCents: 24550, reference: 'Saldo correto' })).status, 200);
});

test('a stale payment confirmation from another tab cannot confirm a revised quotation', async t => {
  const api = await fixture(t);
  const created = await createOrder(api);
  const session = await login(api);
  const path = `/api/admin/orders/${created.json.id}`;
  const change = body => adminRequest(api, session, path, { method: 'PATCH', body });
  const originalQuote = await change({ action: 'quote', amountCents: 49090 });
  assert.equal(originalQuote.status, 200);
  assert.equal(originalQuote.json.order.quote.depositCents, 24545);
  const revisedQuote = await change({ action: 'quote', amountCents: 79090 });
  assert.equal(revisedQuote.status, 200);
  assert.equal(revisedQuote.json.order.quote.depositCents, 39545);
  const staleConfirmation = await change({
    action: 'deposit', expectedAmountCents: 24545, reference: 'Valor visto na aba antiga'
  });
  assert.equal(staleConfirmation.status, 409);
  const unchanged = await adminRequest(api, session, '/api/admin/orders');
  const order = unchanged.json.orders[0];
  assert.equal(order.status, 'quoted');
  assert.equal(order.quote.amountCents, 79090);
  assert.equal(order.payments.deposit, null);
  assert.deepEqual(order.history.map(event => event.action), ['created', 'quote', 'quote']);
  const currentConfirmation = await change({
    action: 'deposit', expectedAmountCents: 39545, reference: 'Valor da proposta revisada'
  });
  assert.equal(currentConfirmation.status, 200);
  assert.equal(currentConfirmation.json.order.status, 'in_progress');
  assert.deepEqual(currentConfirmation.json.order.history.map(event => event.action), ['created', 'quote', 'quote', 'deposit']);
});

test('administrator setup CLI writes private hashed credentials and requires explicit replacement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wsstudio-admin-cli-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'private');
  const credentialPath = join(dataDir, 'admin-auth.json');
  const runSetup = (input, { directory = dataDir, force = false } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      'backend/setup-admin.mjs', '--stdin', '--username', 'cli-admin', ...(force ? ['--force'] : [])
    ], {
      cwd: new URL('..', import.meta.url),
      env: { DATA_DIR: directory },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.once('error', reject);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(`${input}\n`);
  });
  const first = await runSetup(password);
  assert.equal(first.code, 0, first.stderr);
  assert.ok(!`${first.stdout}${first.stderr}`.includes(password));
  const initialContents = await readFile(credentialPath, 'utf8');
  const credentials = JSON.parse(initialContents);
  assert.equal(credentials.username, 'cli-admin');
  assert.equal(await verifyPassword(password, credentials.passwordHash), true);
  assert.ok(!initialContents.includes(password));
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
  const newPassword = 'CLI-Replacement-Password-2026!';
  const withoutForce = await runSetup(newPassword);
  assert.notEqual(withoutForce.code, 0);
  assert.match(withoutForce.stderr, /--force/);
  assert.equal(await readFile(credentialPath, 'utf8'), initialContents);
  const replacement = await runSetup(newPassword, { force: true });
  assert.equal(replacement.code, 0, replacement.stderr);
  assert.ok(!`${replacement.stdout}${replacement.stderr}`.includes(newPassword));
  const updated = JSON.parse(await readFile(credentialPath, 'utf8'));
  assert.equal(await verifyPassword(newPassword, updated.passwordHash), true);
  assert.equal(await verifyPassword(password, updated.passwordHash), false);
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
  const invalidDir = join(root, 'invalid');
  const tooShort = await runSetup('short', { directory: invalidDir });
  assert.notEqual(tooShort.code, 0);
  await assert.rejects(readFile(join(invalidDir, 'admin-auth.json')), { code: 'ENOENT' });
});
