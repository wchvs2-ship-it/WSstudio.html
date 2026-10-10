import { DurableObject } from 'cloudflare:workers';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { serviceCatalog, splitPayment } from '../catalog.js';
import { isPasswordHash, verifyPassword } from '../backend/auth.mjs';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const TOKEN = /^[a-f\d]{64}$/;
const PAYMENT_METHODS = new Set(['Pix', 'Crédito', 'Débito', 'Dinheiro (venda presencial)']);
const ORDER_KEYS = new Set(['serviceId', 'name', 'email', 'business', 'goal', 'paymentMethod', 'maintenanceRequested']);
const ACTION_FIELDS = {
  quote: ['action', 'amountCents', 'notes'],
  deposit: ['action', 'reference', 'expectedAmountCents', 'notes'],
  deliver: ['action', 'notes'],
  balance: ['action', 'reference', 'expectedAmountCents', 'notes'],
  cancel: ['action', 'notes']
};
const BODY_LIMIT = 16 * 1024;
const SESSION_MS = 8 * 60 * 60 * 1000;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
const ASSETS = new Map([
  ['/', '/index.html'], ['/index.html', '/index.html'], ['/style.css', '/style.css'],
  ['/app.js', '/app.js'], ['/catalog.js', '/catalog.js'], ['/admin/', '/admin/index.html'],
  ['/admin/index.html', '/admin/index.html'], ['/admin/admin.js', '/admin/admin.js'],
  ['/admin/admin.css', '/admin/admin.css']
]);

class RequestError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}

function invalid(message) { throw new RequestError(400, message); }
function conflict(message) { throw new RequestError(409, message); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
  });
}

function securityHeaders(response, url) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Content-Security-Policy', CSP);
  if (url.protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function objectBody(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Envie um objeto JSON válido.');
  if (Object.keys(body).some(key => !allowed.has(key))) invalid('O pedido contém campos não permitidos.');
}

function textField(value, label, max, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string') invalid(`${label} deve ser texto.`);
  const cleaned = value.trim();
  if ((!optional && !cleaned) || cleaned.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(cleaned)) {
    invalid(`${label} inválido. Limite: ${max} caracteres.`);
  }
  return cleaned;
}

function validateOrder(body) {
  objectBody(body, ORDER_KEYS);
  const service = serviceCatalog.find(item => item.id === body.serviceId);
  if (!service) invalid('Escolha um serviço válido.');
  const name = textField(body.name, 'Nome', 100);
  const email = textField(body.email, 'E-mail', 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid('Informe um e-mail válido.');
  const business = textField(body.business, 'Negócio', 150);
  const goal = textField(body.goal, 'Objetivo', 2000);
  if (!PAYMENT_METHODS.has(body.paymentMethod)) invalid('Forma de pagamento inválida.');
  if (typeof body.maintenanceRequested !== 'boolean') invalid('Interesse em manutenção deve ser verdadeiro ou falso.');
  return { serviceId: service.id, name, email, business, goal,
    paymentMethod: body.paymentMethod, maintenanceRequested: body.maintenanceRequested };
}

function publicOrder(order) {
  return { id: order.id, createdAt: order.createdAt, serviceName: order.serviceName, estimated: order.estimated };
}

function parseOrigins(value) {
  const values = String(value || '').split(',').map(origin => origin.trim()).filter(Boolean);
  return new Set(values.map(origin => {
    let url;
    try { url = new URL(origin); } catch { throw new Error('ALLOWED_ORIGINS contém uma origem inválida.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new Error('ALLOWED_ORIGINS exige origens completas e exatas, sem caminhos ou curingas.');
    }
    return origin;
  }));
}

function isLoopback(url) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function cookieValue(request, name) {
  const matches = (request.headers.get('Cookie') || '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(name.length + 1);
  return TOKEN.test(token) ? token : null;
}

function equalToken(actual, expected) {
  return typeof actual === 'string' && TOKEN.test(actual) && TOKEN.test(expected)
    && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function sessionCookie(token, development, clear = false) {
  const name = development ? 'ws_session' : '__Host-ws_session';
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict${development ? '' : '; Secure'}; Max-Age=${clear ? 0 : SESSION_MS / 1000}${clear ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : ''}`;
}

async function readBody(request, allowEmpty = false) {
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!allowEmpty && type !== 'application/json') throw new RequestError(415, 'Use Content-Type: application/json.');
  const length = request.headers.get('Content-Length');
  if (length && Number(length) > BODY_LIMIT) throw new RequestError(413, 'O corpo da solicitação excede 16 KB.');
  if (!request.body) {
    if (allowEmpty) return undefined;
    invalid('JSON inválido.');
  }
  const chunks = [];
  let total = 0;
  const reader = request.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > BODY_LIMIT) {
        try { await reader.cancel(); } catch { /* Preserve the size error if the client closes the stream. */ }
        throw new RequestError(413, 'O corpo da solicitação excede 16 KB.');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RequestError) throw error;
    invalid('JSON inválido.');
  } finally {
    reader.releaseLock();
  }
  if (total === 0 && allowEmpty) return undefined;
  if (type !== 'application/json') throw new RequestError(415, 'Use Content-Type: application/json.');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== 'object') invalid('Envie um objeto JSON válido.');
    return parsed;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    invalid('JSON inválido.');
  }
}

// SQLite storage is private to this object. No filesystem or public database endpoint is used.
export class StudioApi extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.storage = ctx.storage;
    this.sql = ctx.storage.sql;
    this.username = env.ADMIN_USERNAME || 'william';
    this.passwordHash = env.ADMIN_PASSWORD_HASH || '';
    this.authConfigured = isPasswordHash(this.passwordHash)
      && typeof this.username === 'string' && /^[A-Za-z0-9_.-]{3,64}$/.test(this.username);
    this.allowedOrigins = parseOrigins(env.ALLOWED_ORIGINS);
    this.storage.transactionSync(() => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL
      )`);
      this.sql.exec('CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at DESC, id)');
      this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
      )`);
      this.sql.exec('CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
      this.sql.exec(`CREATE TABLE IF NOT EXISTS rate_limits (
        bucket TEXT NOT NULL, client_hash TEXT NOT NULL, count INTEGER NOT NULL, reset_at INTEGER NOT NULL,
        PRIMARY KEY (bucket, client_hash)
      )`);
      this.sql.exec('CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(reset_at)');
    });
    this.syncAuthentication();
  }

  one(query, ...bindings) { return this.sql.exec(query, ...bindings).toArray()[0]; }

  syncAuthentication() {
    const fingerprint = hash(`${this.username}:${this.passwordHash || 'unconfigured'}`);
    this.storage.transactionSync(() => {
      const previous = this.one('SELECT value FROM settings WHERE name = ?', 'admin_fingerprint');
      if (previous?.value !== fingerprint) {
        this.sql.exec('DELETE FROM sessions');
        this.sql.exec('INSERT OR REPLACE INTO settings(name, value) VALUES (?, ?)', 'admin_fingerprint', fingerprint);
      }
    });
  }

  limit(request, bucket, max, windowMs) {
    const now = Date.now();
    // Cloudflare supplies the edge client IP; only its digest is retained in the database.
    const clientHash = hash(request.headers.get('CF-Connecting-IP') || 'unknown');
    this.storage.transactionSync(() => {
      let record = this.one('SELECT count, reset_at FROM rate_limits WHERE bucket = ? AND client_hash = ?', bucket, clientHash);
      if (!record || now >= record.reset_at) {
        this.sql.exec('DELETE FROM rate_limits WHERE reset_at <= ?', now);
        if (this.one('SELECT COUNT(*) AS total FROM rate_limits').total >= 10_000) {
          throw new RequestError(429, 'Muitas solicitações. Tente novamente mais tarde.', { 'Retry-After': '60' });
        }
        record = { count: 0, reset_at: now + windowMs };
      }
      const count = Math.min(record.count + 1, max + 1);
      this.sql.exec('INSERT OR REPLACE INTO rate_limits(bucket, client_hash, count, reset_at) VALUES (?, ?, ?, ?)',
        bucket, clientHash, count, record.reset_at);
      // Commit the attempt before reporting a limit, so failed requests remain counted.
    });
    const entry = this.one('SELECT count, reset_at FROM rate_limits WHERE bucket = ? AND client_hash = ?', bucket, clientHash);
    if (entry.count > max) {
      throw new RequestError(429, 'Muitas solicitações. Tente novamente mais tarde.', {
        'Retry-After': String(Math.max(1, Math.ceil((entry.reset_at - now) / 1000)))
      });
    }
  }

  requireSession(request, development) {
    const token = cookieValue(request, development ? 'ws_session' : '__Host-ws_session');
    const tokenHash = token && hash(token);
    const session = tokenHash && this.one('SELECT username, csrf_token, expires_at FROM sessions WHERE token_hash = ?', tokenHash);
    if (!this.authConfigured || !session || session.expires_at <= Date.now() || session.username !== this.username) {
      if (tokenHash) this.sql.exec('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
      throw new RequestError(401, 'Entre no painel para continuar.');
    }
    return { ...session, tokenHash };
  }

  requireCsrf(request, session) {
    if (!equalToken(request.headers.get('X-CSRF-Token'), session.csrf_token)) {
      throw new RequestError(403, 'Sessão inválida para esta alteração. Atualize o painel.');
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = request.headers.get('Origin');
    const admin = path === '/api/admin' || path.startsWith('/api/admin/');
    const corsHeaders = {};
    try {
      if (origin && origin !== url.origin && (admin || !this.allowedOrigins.has(origin))) {
        throw new RequestError(403, 'Origem não permitida.');
      }
      if (admin && url.protocol !== 'https:' && !isLoopback(url)) {
        throw new RequestError(403, 'O painel requer conexão HTTPS.');
      }
      if (!admin && origin && (origin === url.origin || this.allowedOrigins.has(origin))) {
        corsHeaders['Access-Control-Allow-Origin'] = origin;
        corsHeaders.Vary = 'Origin';
        if (request.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: {
            ...corsHeaders, 'Cache-Control': 'no-store',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key'
          } });
        }
      }
      const body = ['POST', 'PATCH'].includes(request.method)
        ? await readBody(request, path === '/api/admin/logout') : undefined;
      this.syncAuthentication();
      const response = this.route(request, url, body);
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(corsHeaders)) headers.set(name, value);
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      if (error instanceof RequestError) return json({ error: error.message }, error.status, { ...corsHeaders, ...error.headers });
      return json({ error: 'Não foi possível concluir a solicitação.' }, 500, corsHeaders);
    }
  }

  route(request, url, body) {
    const path = url.pathname;
    const method = request.method;
    const development = isLoopback(url);
    if (method === 'GET' && path === '/api/health') return json({ status: 'ok' });
    if (method === 'GET' && path === '/api/services') return json({ services: serviceCatalog });
    if (method === 'POST' && path === '/api/orders') {
      this.limit(request, 'orders', 15, 60 * 60 * 1000);
      const key = request.headers.get('Idempotency-Key');
      if (!key || !UUID.test(key)) invalid('Envie uma chave UUID válida em Idempotency-Key.');
      const details = validateOrder(body);
      const requestHash = hash(JSON.stringify(details));
      // All SQL reads and writes in the idempotent creation happen in one synchronous transaction.
      return this.storage.transactionSync(() => {
        const existing = this.one('SELECT payload, request_hash FROM orders WHERE idempotency_key = ?', key.toLowerCase());
        if (existing) {
          if (existing.request_hash !== requestHash) conflict('Esta chave de pedido já foi usada com outros dados.');
          return json(publicOrder(JSON.parse(existing.payload)), 200, { 'Idempotency-Replayed': 'true' });
        }
        const service = serviceCatalog.find(item => item.id === details.serviceId);
        const now = new Date().toISOString();
        const order = {
          id: randomUUID(), createdAt: now, serviceId: service.id, serviceName: service.name,
          customer: { name: details.name, email: details.email, business: details.business, goal: details.goal },
          paymentMethod: details.paymentMethod, maintenanceRequested: details.maintenanceRequested,
          estimated: { minCents: service.min, maxCents: service.max }, status: 'new', quote: null,
          payments: { deposit: null, balance: null }, history: [{ action: 'created', at: now }]
        };
        this.sql.exec('INSERT INTO orders(id, created_at, payload, idempotency_key, request_hash) VALUES (?, ?, ?, ?, ?)',
          order.id, now, JSON.stringify(order), key.toLowerCase(), requestHash);
        return json(publicOrder(order), 201);
      });
    }
    if (method === 'POST' && path === '/api/admin/login') {
      this.limit(request, 'login', 10, 15 * 60 * 1000);
      if (!this.authConfigured) throw new RequestError(503, 'Administrador ainda não configurado.');
      objectBody(body, new Set(['username', 'password']));
      const valid = typeof body.username === 'string' && typeof body.password === 'string'
        && body.username.length <= 64 && body.password.length <= 256;
      // Password derivation stays inside the Durable Object, whose CPU budget supports scrypt.
      const matches = valid && verifyPassword(body.password, this.passwordHash);
      if (!matches || body.username !== this.username) throw new RequestError(401, 'Usuário ou senha incorretos.');
      const token = randomBytes(32).toString('hex');
      const csrfToken = randomBytes(32).toString('hex');
      this.storage.transactionSync(() => {
        this.sql.exec('DELETE FROM sessions WHERE expires_at <= ?', Date.now());
        const oldToken = cookieValue(request, development ? 'ws_session' : '__Host-ws_session');
        if (oldToken) this.sql.exec('DELETE FROM sessions WHERE token_hash = ?', hash(oldToken));
        this.sql.exec('INSERT INTO sessions(token_hash, username, csrf_token, expires_at) VALUES (?, ?, ?, ?)',
          hash(token), this.username, csrfToken, Date.now() + SESSION_MS);
      });
      return json({ username: this.username, csrfToken }, 200, { 'Set-Cookie': sessionCookie(token, development) });
    }
    if (method === 'GET' && path === '/api/admin/session') {
      const session = this.requireSession(request, development);
      return json({ username: session.username, csrfToken: session.csrf_token });
    }
    if (method === 'POST' && path === '/api/admin/logout') {
      const session = this.requireSession(request, development);
      this.requireCsrf(request, session);
      this.sql.exec('DELETE FROM sessions WHERE token_hash = ?', session.tokenHash);
      return new Response(null, { status: 204, headers: {
        'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie('', development, true)
      } });
    }
    if (method === 'GET' && path === '/api/admin/orders') {
      this.requireSession(request, development);
      const pageText = url.searchParams.get('page') ?? '1';
      const limitText = url.searchParams.get('limit') ?? '20';
      if (url.searchParams.getAll('page').length > 1 || url.searchParams.getAll('limit').length > 1
        || !/^[1-9]\d*$/.test(pageText) || !/^[1-9]\d*$/.test(limitText)) invalid('Paginação inválida.');
      const page = Number(pageText);
      const limit = Number(limitText);
      if (!Number.isSafeInteger(page) || page > 1_000_000 || limit > 100) invalid('Paginação inválida.');
      const orders = this.sql.exec('SELECT payload FROM orders ORDER BY created_at DESC, id LIMIT ? OFFSET ?',
        limit, (page - 1) * limit).toArray().map(row => JSON.parse(row.payload));
      return json({ orders, total: this.one('SELECT COUNT(*) AS total FROM orders').total, page, limit });
    }
    const match = /^\/api\/admin\/orders\/([^/]+)$/.exec(path);
    if (method === 'PATCH' && match) {
      const session = this.requireSession(request, development);
      this.requireCsrf(request, session);
      return this.changeOrder(match[1], body);
    }
    return json({ error: 'Rota não encontrada.' }, 404);
  }

  changeOrder(id, body) {
    if (!UUID.test(id)) invalid('Identificador de pedido inválido.');
    objectBody(body, new Set(['action', 'amountCents', 'expectedAmountCents', 'notes', 'reference']));
    const fields = Object.hasOwn(ACTION_FIELDS, body.action) ? ACTION_FIELDS[body.action] : null;
    if (!fields || Object.keys(body).some(key => !fields.includes(key))) invalid('Ação ou campos inválidos.');
    if (['deposit', 'balance'].includes(body.action)
      && (!Number.isSafeInteger(body.expectedAmountCents) || body.expectedAmountCents <= 0)) {
      invalid('Informe o valor da parcela confirmada como um inteiro positivo em centavos.');
    }
    const notes = textField(body.notes, 'Observação', 2000, true);
    const at = new Date().toISOString();
    return this.storage.transactionSync(() => {
      const record = this.one('SELECT payload FROM orders WHERE id = ?', id);
      if (!record) throw new RequestError(404, 'Pedido não encontrado.');
      const order = JSON.parse(record.payload);
      const event = { action: body.action, at };
      if (notes) event.notes = notes;
      switch (body.action) {
        case 'quote': {
          if (!['new', 'quoted'].includes(order.status) || order.payments.deposit) conflict('Este pedido não permite alterar o orçamento.');
          const amount = body.amountCents;
          if (!Number.isSafeInteger(amount) || amount < 2 || amount > 100_000_000) {
            invalid('Valor deve ser um inteiro em centavos, entre R$ 0,02 e R$ 1.000.000,00, para as duas parcelas serem positivas.');
          }
          const parts = splitPayment(amount);
          order.quote = { amountCents: amount, depositCents: parts.deposit, balanceCents: parts.balance, notes };
          order.status = 'quoted';
          break;
        }
        case 'deposit': {
          if (order.status !== 'quoted' || !order.quote || order.payments.deposit) conflict('Confirme um orçamento antes de registrar a entrada.');
          if (body.expectedAmountCents !== order.quote.depositCents) conflict('O orçamento mudou. Atualize o pedido e confira novamente o valor recebido.');
          const reference = textField(body.reference, 'Referência do recebimento', 120);
          order.payments.deposit = { confirmedAt: at, reference };
          order.status = 'in_progress'; event.reference = reference;
          break;
        }
        case 'deliver':
          if (order.status !== 'in_progress' || !order.payments.deposit) conflict('A entrega exige a entrada confirmada e o serviço em execução.');
          order.status = 'delivered';
          break;
        case 'balance': {
          if (order.status !== 'delivered' || !order.quote || !order.payments.deposit || order.payments.balance) conflict('Confirme a entrega antes de registrar a quitação.');
          if (body.expectedAmountCents !== order.quote.balanceCents) conflict('O valor de quitação mudou. Atualize o pedido e confira novamente o valor recebido.');
          const reference = textField(body.reference, 'Referência do recebimento', 120);
          order.payments.balance = { confirmedAt: at, reference };
          order.status = 'completed'; event.reference = reference;
          break;
        }
        case 'cancel':
          if (!['new', 'quoted'].includes(order.status) || order.payments.deposit) conflict('Cancelamento disponível apenas antes do recebimento da entrada.');
          order.status = 'cancelled';
          break;
      }
      order.history.push(event);
      this.sql.exec('UPDATE orders SET payload = ? WHERE id = ?', JSON.stringify(order), order.id);
      return json({ order });
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let response;
    try {
      const publicPage = ASSETS.has(url.pathname) || url.pathname === '/admin' || url.pathname === '/api-config.js';
      if (['GET', 'HEAD'].includes(request.method) && publicPage && url.protocol === 'http:' && !isLoopback(url)) {
        const secureUrl = new URL(url);
        secureUrl.protocol = 'https:';
        response = new Response(null, { status: 308, headers: {
          Location: secureUrl.href, 'Cache-Control': 'no-store'
        } });
      } else if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const stub = env.STUDIO_API.get(env.STUDIO_API.idFromName('studio'));
        response = await stub.fetch(request);
      } else if (['GET', 'HEAD'].includes(request.method) && url.pathname === '/api-config.js') {
        response = new Response(request.method === 'HEAD' ? null :
          'window.WS_API_CONFIG = Object.freeze({ enabled: true, baseUrl: "" });\n', {
          headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }
        });
      } else if (['GET', 'HEAD'].includes(request.method) && url.pathname === '/admin') {
        response = new Response(null, { status: 302, headers: { Location: '/admin/', 'Cache-Control': 'no-store' } });
      } else if (['GET', 'HEAD'].includes(request.method) && ASSETS.has(url.pathname)) {
        const asset = ASSETS.get(url.pathname);
        const assetUrl = new URL(asset, url);
        response = await env.ASSETS.fetch(new Request(assetUrl, request));
        const headers = new Headers(response.headers);
        headers.set('Cache-Control', asset.startsWith('/admin/') ? 'no-store' : 'no-cache');
        response = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      } else {
        response = new Response(request.method === 'HEAD' ? null : 'Não encontrado.', {
          status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
        });
      }
    } catch {
      response = url.pathname === '/api' || url.pathname.startsWith('/api/')
        ? json({ error: 'Não foi possível concluir a solicitação.' }, 503)
        : new Response('Não foi possível concluir a solicitação.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    return securityHeaders(response, url);
  }
};
