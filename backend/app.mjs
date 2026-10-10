import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceCatalog, splitPayment } from '../catalog.js';
import { isPasswordHash, verifyPassword } from './auth.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const PAYMENT_METHODS = new Set(['Pix', 'Crédito', 'Débito', 'Dinheiro (venda presencial)']);
const ORDER_KEYS = new Set(['serviceId', 'name', 'email', 'business', 'goal', 'paymentMethod', 'maintenanceRequested']);
const ACTION_KEYS = new Set(['action', 'amountCents', 'expectedAmountCents', 'notes', 'reference']);
const TOKEN_PATTERN = /^[a-f\d]{64}$/;
const SESSION_MS = 8 * 60 * 60 * 1000;

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function invalid(message) { throw new RequestError(400, message); }
function conflict(message) { throw new RequestError(409, message); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }

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
  const origins = Array.isArray(value) ? value : String(value || '').split(',').filter(Boolean);
  return new Set(origins.map(origin => {
    const trimmed = origin.trim();
    let url;
    try { url = new URL(trimmed); } catch { throw new Error('ALLOWED_ORIGINS contém uma origem inválida.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== trimmed) {
      throw new Error('ALLOWED_ORIGINS exige origens completas e exatas, sem caminhos ou curingas.');
    }
    return trimmed;
  }));
}

function limiter({ max, windowMs }) {
  const clients = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    let entry = clients.get(key);
    if (!entry || now >= entry.resetAt) {
      if (clients.size >= 10_000) {
        for (const [ip, record] of clients) if (now >= record.resetAt) clients.delete(ip);
        if (clients.size >= 10_000) return res.status(429).json({ error: 'Muitas solicitações. Tente novamente mais tarde.' });
      }
      entry = { count: 0, resetAt: now + windowMs };
      clients.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'Muitas solicitações. Tente novamente mais tarde.' });
    }
    next();
  };
}

function cookieValue(req, name) {
  const matches = (req.headers.cookie || '').split(';').map(item => item.trim()).filter(item => item.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(name.length + 1);
  return TOKEN_PATTERN.test(token) ? token : null;
}

function equalToken(actual, expected) {
  if (typeof actual !== 'string' || !TOKEN_PATTERN.test(actual) || !TOKEN_PATTERN.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

export function createApp(options = {}) {
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || resolve(ROOT, '.data'));
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const allowedOrigins = parseOrigins(options.allowedOrigins ?? process.env.ALLOWED_ORIGINS);
  const trustProxy = options.trustProxy ?? false;
  let username = options.adminUsername || process.env.ADMIN_USERNAME || 'william';
  let passwordHash = options.adminPasswordHash ?? process.env.ADMIN_PASSWORD_HASH;
  const authFile = resolve(dataDir, 'admin-auth.json');
  if (!passwordHash && existsSync(authFile)) {
    const credentials = JSON.parse(readFileSync(authFile, 'utf8'));
    username = credentials.username;
    passwordHash = credentials.passwordHash;
  }
  if (passwordHash && (!isPasswordHash(passwordHash) || typeof username !== 'string' || !/^[A-Za-z0-9_.-]{3,64}$/.test(username))) {
    throw new Error('Configuração de administrador inválida. Execute npm run admin:setup.');
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const databasePath = resolve(dataDir, 'studio.sqlite');
  const db = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at DESC, id);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const fingerprint = hash(`${username}:${passwordHash || 'unconfigured'}`);
  const previousFingerprint = db.prepare('SELECT value FROM settings WHERE name = ?').get('admin_fingerprint');
  if (previousFingerprint?.value !== fingerprint) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM sessions');
      db.prepare('INSERT OR REPLACE INTO settings(name, value) VALUES (?, ?)').run('admin_fingerprint', fingerprint);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  const findOrder = db.prepare('SELECT payload FROM orders WHERE id = ?');
  const findIdempotency = db.prepare('SELECT payload, request_hash FROM orders WHERE idempotency_key = ?');
  const insertOrder = db.prepare('INSERT INTO orders(id, created_at, payload, idempotency_key, request_hash) VALUES (?, ?, ?, ?, ?)');
  const updateOrder = db.prepare('UPDATE orders SET payload = ? WHERE id = ?');
  const countOrders = db.prepare('SELECT COUNT(*) AS total FROM orders');
  const listOrders = db.prepare('SELECT payload FROM orders ORDER BY created_at DESC, id LIMIT ? OFFSET ?');
  const findSession = db.prepare('SELECT username, csrf_token, expires_at FROM sessions WHERE token_hash = ?');
  const createSession = db.prepare('INSERT INTO sessions(token_hash, username, csrf_token, expires_at) VALUES (?, ?, ?, ?)');
  const removeSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const removeExpiredSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
  const cookieName = production ? '__Host-ws_session' : 'ws_session';
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: production, path: '/', maxAge: SESSION_MS };
  const app = express();
  app.disable('x-powered-by');
  app.enable('strict routing');
  app.enable('case sensitive routing');
  app.set('trust proxy', trustProxy);
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (production && req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('Origin');
    const ownOrigin = `${req.protocol}://${req.get('host')}`;
    const adminRequest = req.path === '/admin' || req.path.startsWith('/admin/');
    if (origin && origin !== ownOrigin && (adminRequest || !allowedOrigins.has(origin))) {
      return res.status(403).json({ error: 'Origem não permitida.' });
    }
    if (adminRequest && production && !req.secure) return res.status(403).json({ error: 'O painel requer conexão HTTPS.' });
    if (!adminRequest && origin && (origin === ownOrigin || allowedOrigins.has(origin))) {
      res.vary('Origin');
      res.set('Access-Control-Allow-Origin', origin);
      if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
        return res.sendStatus(204);
      }
    }
    next();
  });
  app.use('/api', express.json({ limit: '16kb', strict: true }));
  app.use('/api', (req, res, next) => {
    if (['POST', 'PATCH'].includes(req.method) && req.path !== '/admin/logout' && !req.is('application/json')) {
      return res.status(415).json({ error: 'Use Content-Type: application/json.' });
    }
    next();
  });
  const ordersLimit = limiter({ max: 15, windowMs: 60 * 60 * 1000, ...options.rateLimits?.orders });
  const loginLimit = limiter({ max: 10, windowMs: 15 * 60 * 1000, ...options.rateLimits?.login });

  function requireSession(req, res, next) {
    const token = cookieValue(req, cookieName);
    const tokenHash = token && hash(token);
    const session = tokenHash && findSession.get(tokenHash);
    if (!session || session.expires_at <= Date.now() || session.username !== username || !passwordHash) {
      if (tokenHash) removeSession.run(tokenHash);
      return res.status(401).json({ error: 'Entre no painel para continuar.' });
    }
    req.session = { ...session, tokenHash };
    next();
  }

  function requireCsrf(req, res, next) {
    if (!equalToken(req.get('X-CSRF-Token'), req.session.csrf_token)) {
      return res.status(403).json({ error: 'Sessão inválida para esta alteração. Atualize o painel.' });
    }
    next();
  }

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/api/services', (req, res) => res.json({ services: serviceCatalog }));
  app.post('/api/orders', ordersLimit, (req, res) => {
    const idempotencyKey = req.get('Idempotency-Key');
    if (!idempotencyKey || !UUID.test(idempotencyKey)) invalid('Envie uma chave UUID válida em Idempotency-Key.');
    const details = validateOrder(req.body);
    const requestHash = hash(JSON.stringify(details));
    const existing = findIdempotency.get(idempotencyKey.toLowerCase());
    if (existing) {
      if (existing.request_hash !== requestHash) conflict('Esta chave de pedido já foi usada com outros dados.');
      res.set('Idempotency-Replayed', 'true');
      return res.status(200).json(publicOrder(JSON.parse(existing.payload)));
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
    insertOrder.run(order.id, now, JSON.stringify(order), idempotencyKey.toLowerCase(), requestHash);
    res.status(201).json(publicOrder(order));
  });
  app.post('/api/admin/login', loginLimit, (req, res) => {
    if (!passwordHash) return res.status(503).json({ error: 'Administrador ainda não configurado.' });
    objectBody(req.body, new Set(['username', 'password']));
    const valid = typeof req.body.username === 'string' && typeof req.body.password === 'string'
      && req.body.username.length <= 64 && req.body.password.length <= 256;
    const matches = valid && verifyPassword(req.body.password, passwordHash);
    if (!matches || req.body.username !== username) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    removeExpiredSessions.run(Date.now());
    const oldToken = cookieValue(req, cookieName);
    if (oldToken) removeSession.run(hash(oldToken));
    const token = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    createSession.run(hash(token), username, csrfToken, Date.now() + SESSION_MS);
    res.cookie(cookieName, token, cookieOptions);
    res.json({ username, csrfToken });
  });
  app.get('/api/admin/session', requireSession, (req, res) => {
    res.json({ username: req.session.username, csrfToken: req.session.csrf_token });
  });
  app.post('/api/admin/logout', requireSession, requireCsrf, (req, res) => {
    removeSession.run(req.session.tokenHash);
    const { maxAge, ...clearOptions } = cookieOptions;
    res.clearCookie(cookieName, clearOptions);
    res.sendStatus(204);
  });
  app.get('/api/admin/orders', requireSession, (req, res) => {
    const pageText = req.query.page ?? '1';
    const limitText = req.query.limit ?? '20';
    if (typeof pageText !== 'string' || typeof limitText !== 'string' || !/^[1-9]\d*$/.test(pageText) || !/^[1-9]\d*$/.test(limitText)) {
      invalid('Paginação inválida.');
    }
    const page = Number(pageText);
    const limit = Number(limitText);
    if (!Number.isSafeInteger(page) || page > 1_000_000 || limit > 100) invalid('Paginação inválida.');
    const orders = listOrders.all(limit, (page - 1) * limit).map(row => JSON.parse(row.payload));
    res.json({ orders, total: countOrders.get().total, page, limit });
  });
  app.patch('/api/admin/orders/:id', requireSession, requireCsrf, (req, res) => {
    if (!UUID.test(req.params.id)) invalid('Identificador de pedido inválido.');
    objectBody(req.body, ACTION_KEYS);
    const allowedActionFields = {
      quote: ['action', 'amountCents', 'notes'], deposit: ['action', 'reference', 'expectedAmountCents', 'notes'],
      deliver: ['action', 'notes'], balance: ['action', 'reference', 'expectedAmountCents', 'notes'], cancel: ['action', 'notes']
    };
    const fields = Object.hasOwn(allowedActionFields, req.body.action) ? allowedActionFields[req.body.action] : null;
    if (!fields || Object.keys(req.body).some(key => !fields.includes(key))) invalid('Ação ou campos inválidos.');
    if (['deposit', 'balance'].includes(req.body.action)
      && (!Number.isSafeInteger(req.body.expectedAmountCents) || req.body.expectedAmountCents <= 0)) {
      invalid('Informe o valor da parcela confirmada como um inteiro positivo em centavos.');
    }
    const notes = textField(req.body.notes, 'Observação', 2000, true);
    const at = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const record = findOrder.get(req.params.id);
      if (!record) throw new RequestError(404, 'Pedido não encontrado.');
      const order = JSON.parse(record.payload);
      const event = { action: req.body.action, at };
      if (notes) event.notes = notes;
      switch (req.body.action) {
        case 'quote': {
          if (!['new', 'quoted'].includes(order.status) || order.payments.deposit) conflict('Este pedido não permite alterar o orçamento.');
          const amount = req.body.amountCents;
          if (!Number.isSafeInteger(amount) || amount < 2 || amount > 100_000_000) invalid('Valor deve ser um inteiro em centavos, entre R$ 0,02 e R$ 1.000.000,00, para as duas parcelas serem positivas.');
          const parts = splitPayment(amount);
          order.quote = { amountCents: amount, depositCents: parts.deposit, balanceCents: parts.balance, notes };
          order.status = 'quoted';
          break;
        }
        case 'deposit': {
          if (order.status !== 'quoted' || !order.quote || order.payments.deposit) conflict('Confirme um orçamento antes de registrar a entrada.');
          if (req.body.expectedAmountCents !== order.quote.depositCents) {
            conflict('O orçamento mudou. Atualize o pedido e confira novamente o valor recebido.');
          }
          const reference = textField(req.body.reference, 'Referência do recebimento', 120);
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
          if (req.body.expectedAmountCents !== order.quote.balanceCents) {
            conflict('O valor de quitação mudou. Atualize o pedido e confira novamente o valor recebido.');
          }
          const reference = textField(req.body.reference, 'Referência do recebimento', 120);
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
      updateOrder.run(JSON.stringify(order), order.id);
      db.exec('COMMIT');
      res.json({ order });
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

  const assets = new Map([
    ['/', 'index.html'], ['/index.html', 'index.html'], ['/style.css', 'style.css'],
    ['/app.js', 'app.js'], ['/catalog.js', 'catalog.js'], ['/admin/', 'admin/index.html'],
    ['/admin/index.html', 'admin/index.html'], ['/admin/admin.js', 'admin/admin.js'], ['/admin/admin.css', 'admin/admin.css']
  ]);
  app.get('/api-config.js', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('text/javascript').send('window.WS_API_CONFIG = Object.freeze({ enabled: true, baseUrl: "" });\n');
  });
  app.get('/admin', (req, res) => res.redirect(302, '/admin/'));
  app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) || !assets.has(req.path)) return next();
    const asset = assets.get(req.path);
    res.set('Cache-Control', asset.startsWith('admin/') ? 'no-store' : 'no-cache');
    res.sendFile(resolve(ROOT, asset));
  });
  app.use((req, res) => res.status(404).type('text/plain').send('Não encontrado.'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof RequestError) return res.status(error.status).json({ error: error.message });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'O corpo da solicitação excede 16 KB.' });
    if (error.type === 'entity.parse.failed' || error.type === 'request.aborted') return res.status(400).json({ error: 'JSON inválido.' });
    if (error.status === 404) return res.status(404).type('text/plain').send('Não encontrado.');
    res.status(500).json({ error: 'Não foi possível concluir a solicitação.' });
  });
  let closed = false;
  return { app, close() { if (!closed) { closed = true; db.close(); } } };
}
