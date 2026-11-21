'use strict';
/**
 * Servidor del CRM Activemur — Node puro, sin dependencias.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const dbm = require('./db');
const auth = require('./auth');

const PORT = Number(process.env.CRM_PORT || 8090);
const HOST = process.env.CRM_HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const WEBHOOK_TOKEN = process.env.CRM_WEBHOOK_TOKEN || '';
const COOKIE = process.env.CRM_COOKIE_NAME || 'crm_sid';
const SECURE_COOKIE = process.env.CRM_HTTPS === '1';
const crypto = require('crypto');

/* Orígenes autorizados para el tracking público (landing / WordPress). */
const ALLOWED_ORIGINS = (process.env.CRM_ALLOWED_ORIGINS ||
  'https://activemur.es,https://www.activemur.es,https://aseva71.github.io,https://activemur-web.vercel.app,http://localhost:3024,http://127.0.0.1:3024'
).split(',').map(s => s.trim()).filter(Boolean);

function cors(req, res) {
  const origin = req.headers.origin || '';
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    return true;
  }
  return !origin; // sin Origin (curl, server-to-server) se permite
}

/** Hash de IP con sal diaria: cuenta visitas únicas sin guardar la IP. */
function ipHash(ip) {
  return crypto.createHash('sha256')
    .update(String(ip) + '|' + new Date().toISOString().slice(0, 10))
    .digest('hex').slice(0, 32);
}

const trackHits = new Map();
function rateLimit(ip, key, max, windowMs) {
  const k = key + '|' + ip;
  const now = Date.now();
  const hits = (trackHits.get(k) || []).filter(t => now - t < windowMs);
  hits.push(now);
  trackHits.set(k, hits);
  if (trackHits.size > 5000) trackHits.clear();
  return hits.length <= max;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

/* ---------------- helpers ---------------- */

function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function cookieHeader(token, maxAgeSec) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (SECURE_COOKIE) parts.push('Secure');
  return parts.join('; ');
}

function currentUser(req) {
  const cookies = auth.parseCookies(req.headers.cookie);
  return auth.getSessionUser(cookies[COOKIE]);
}

/* ---------------- estáticos ---------------- */

function assetVersion(file) {
  try { return Math.floor(fs.statSync(path.join(PUBLIC_DIR, file)).mtimeMs).toString(36); }
  catch { return '0'; }
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('No encontrado'); }
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.html') {
      // Versión en la URL de los assets: si cambian en disco, el navegador pide los nuevos.
      const html = data.toString('utf8')
        .replace('/app.js"', `/app.js?v=${assetVersion('app.js')}"`)
        .replace('/styles.css"', `/styles.css?v=${assetVersion('styles.css')}"`);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(html);
    }

    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ---------------- validación ---------------- */

const SOURCES = ['web_form', 'whatsapp', 'telefono', 'feria', 'referido', 'redes', 'otro'];
const PRODUCTS = ['osmosis', 'descalcificador', 'fuente', 'enfriador', 'purificador_aire',
                  'filterqueen', 'hidrogenacion', 'limpieza', 'otro'];
const ALL_STATUSES = ['nuevo', 'contactado', 'cita', 'visitado', 'presupuestado', 'ganado', 'perdido', 'descartado'];

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/* ---------------- API ---------------- */

const loginAttempts = new Map(); // ip -> { n, until }

async function handleApi(req, res, pathname, query) {
  const method = req.method;
  const user = currentUser(req);

  /* --- sesión --- */
  if (pathname === '/api/login' && method === 'POST') {
    const ip = clientIp(req);
    const rec = loginAttempts.get(ip);
    if (rec && rec.n >= 8 && rec.until > Date.now()) {
      return json(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' });
    }
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'Cuerpo inválido' });

    const row = dbm.db.prepare('SELECT * FROM users WHERE username = ? AND active = 1')
      .get(String(body.username || '').trim().toLowerCase());

    if (!row || !auth.verifyPassword(body.password || '', row.password_hash)) {
      const cur = loginAttempts.get(ip) || { n: 0, until: 0 };
      cur.n += 1;
      cur.until = Date.now() + 5 * 60_000;
      loginAttempts.set(ip, cur);
      return json(res, 401, { error: 'Usuario o contraseña incorrectos' });
    }

    loginAttempts.delete(ip);
    const token = auth.createSession(row.id, ip, req.headers['user-agent']);
    dbm.audit(row.id, 'login', `Acceso de ${row.name} (${ip})`);
    return json(res, 200,
      { user: { id: row.id, username: row.username, name: row.name, role: row.role } },
      { 'Set-Cookie': cookieHeader(token, 30 * 86400) });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const cookies = auth.parseCookies(req.headers.cookie);
    auth.destroySession(cookies[COOKIE]);
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) });
  }

  if (pathname === '/api/me' && method === 'GET') {
    if (!user) return json(res, 401, { error: 'No autenticado' });
    return json(res, 200, { user });
  }

  if (pathname === '/api/me/password' && method === 'POST') {
    if (!user) return json(res, 401, { error: 'No autenticado' });
    const body = await readBody(req);
    const row = dbm.db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (!auth.verifyPassword(body.current || '', row.password_hash)) {
      return json(res, 400, { error: 'La contraseña actual no es correcta' });
    }
    if (!body.next || String(body.next).length < 8) {
      return json(res, 400, { error: 'La nueva contraseña debe tener al menos 8 caracteres' });
    }
    dbm.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(body.next), user.id);
    dbm.audit(user.id, 'password', 'Cambio de contraseña propio');
    return json(res, 200, { ok: true });
  }

  /* --- tracking público (landing y WordPress) --- */
  if ((pathname === '/api/track' || pathname === '/api/public/lead') && method === 'OPTIONS') {
    const ok = cors(req, res);
    res.writeHead(ok ? 204 : 403);
    return res.end();
  }

  if (pathname === '/api/track' && method === 'POST') {
    if (!cors(req, res)) return json(res, 403, { error: 'Origen no autorizado' });
    const ip = clientIp(req);
    if (!rateLimit(ip, 'track', 180, 60_000)) return json(res, 429, { error: 'Demasiadas peticiones' });
    const body = await readBody(req, 64_000);
    if (!body || typeof body !== 'object') return json(res, 400, { error: 'Cuerpo inválido' });
    if (!body.vid || !body.event) return json(res, 400, { error: 'Faltan vid o event' });
    const row = dbm.trackEvent({
      ...body,
      host: body.host || req.headers.host,
      ip_hash: ipHash(ip),
      ua: req.headers['user-agent'],
    });
    return json(res, 202, { ok: true, event: row.event });
  }

  if (pathname === '/api/public/lead' && method === 'POST') {
    if (!cors(req, res)) return json(res, 403, { error: 'Origen no autorizado' });
    const ip = clientIp(req);
    if (!rateLimit(ip, 'lead', 8, 60_000)) {
      return json(res, 429, { error: 'Demasiados envíos. Inténtalo en un minuto.' });
    }
    const body = await readBody(req, 64_000);
    if (!body || typeof body !== 'object') return json(res, 400, { error: 'Cuerpo inválido' });
    if (body.website) return json(res, 200, { ok: true, ignored: true }); // honeypot

    const phone = String(body.phone || body.telefono || '').replace(/[^\d+ ]/g, '').trim();
    const email = String(body.email || '').trim();
    if (!phone && !email) return json(res, 400, { error: 'Falta teléfono o email' });
    if (!body.consent && !body.rgpd) return json(res, 400, { error: 'Falta el consentimiento' });

    const ident = phone || email;
    const dup = dbm.db.prepare(`
      SELECT id, ref FROM leads
      WHERE (phone = ? OR email = ?) AND created_at > ?
      LIMIT 1
    `).get(phone, email, new Date(Date.now() - 864e5).toISOString());
    if (dup) return json(res, 200, { ok: true, duplicate: true, ref: dup.ref });

    const PRODUCT_MAP = {
      osmosis: 'osmosis', descalcificacion: 'descalcificador', descalcificador: 'descalcificador',
      fuentes: 'fuente', fuente: 'fuente', enfriamiento: 'enfriador', hidrogenacion: 'hidrogenacion',
      aire: 'purificador_aire', purificador_aire: 'purificador_aire', general: 'otro',
    };
    const touch = {
      channel: dbm.channelOf(body),
      utm_source: body.utm_source || null, utm_medium: body.utm_medium || null,
      utm_campaign: body.utm_campaign || null, utm_content: body.utm_content || null,
      utm_term: body.utm_term || null, gclid: body.gclid || null,
      landing_page: body.landing_page || body.page || null,
      referrer: body.referrer || null,
      at: new Date().toISOString(),
    };

    const lead = dbm.createLead({
      source: body.source || 'web_form',
      utm_source: body.utm_source, utm_medium: body.utm_medium, utm_campaign: body.utm_campaign,
      utm_content: body.utm_content, utm_term: body.utm_term,
      page: body.landing_page || body.page,
      name: String(body.name || body.nombre || '').slice(0, 120),
      phone: phone || null,
      email: email || null,
      locality: String(body.locality || body.localidad || '').slice(0, 120) || null,
      postal_code: String(body.postal_code || '').slice(0, 10) || null,
      client_type: String(body.client_type || '').toLowerCase() === 'empresa' ? 'empresa' : 'particular',
      product: PRODUCT_MAP[String(body.product || body.solucion || '').toLowerCase()] || null,
      message: String(body.message || body.mensaje || '').slice(0, 2000) || null,
      self_reported: String(body.self_reported || body.como_nos_conocio || '').slice(0, 200) || null,
      vid: body.vid || null,
      gclid: body.gclid || null,
      fbclid: body.fbclid || null,
      msclkid: body.msclkid || null,
      landing_page: body.landing_page || null,
      referrer: body.referrer || null,
      first_touch: JSON.stringify(touch),
      last_touch: JSON.stringify(touch),
    }, null, ip);

    // Enlaza la visita con el lead (mismo vid) para poder reconstruir el recorrido.
    if (body.vid) {
      try {
        dbm.db.prepare("UPDATE visits SET event = 'lead' WHERE vid = ? AND event = 'form_submit'")
          .run(String(body.vid));
      } catch { /* noop */ }
    }

    dbm.logEvent(lead.id, null, 'web_form', `Lead público ${lead.ref} (${ident})`);
    return json(res, 201, { ok: true, ref: lead.ref, id: lead.id });
  }

  if (pathname === '/api/metrics' && method === 'GET') {
    /* Lectura para agentes/informes: token propio, sin sesión y sin PII. */
    const mt = process.env.CRM_METRICS_TOKEN || '';
    const given = req.headers['x-metrics-token'] || query.get('token') || '';
    if (!mt) return json(res, 503, { error: 'Métricas no configuradas' });
    if (given !== mt) return json(res, 401, { error: 'Token inválido' });
    const month = query.get('month') || new Date().toISOString().slice(0, 7);
    const s = dbm.stats(month);
    const t = dbm.trafficStats(month);
    const pend = dbm.db.prepare(`
      SELECT COUNT(*) AS n FROM leads
      WHERE status = 'nuevo' AND created_at < ?
    `).get(new Date(Date.now() - 2 * 3600e3).toISOString()).n;
    return json(res, 200, {
      month, stats: s, traffic: t,
      alerts: { sin_contactar_2h: pend },
      generated_at: new Date().toISOString(),
    });
  }

  /* --- webhook público (WordPress) --- */
  if (pathname === '/api/webhook/lead' && method === 'POST') {
    if (!WEBHOOK_TOKEN) return json(res, 503, { error: 'Webhook no configurado' });
    const token = req.headers['x-webhook-token'] || query.get('token') || '';
    if (token !== WEBHOOK_TOKEN) return json(res, 401, { error: 'Token inválido' });

    const body = await readBody(req);
    if (!body || (!body.phone && !body.email)) {
      return json(res, 400, { error: 'Faltan datos de contacto (phone o email)' });
    }

    // dedupe básico: mismo teléfono/email en las últimas 24h
    const ident = body.phone || body.email;
    const dup = dbm.db.prepare(`
      SELECT id, ref FROM leads
      WHERE (phone = ? OR email = ?) AND created_at > ?
      LIMIT 1
    `).get(body.phone || '', body.email || '', new Date(Date.now() - 864e5).toISOString());

    if (dup) return json(res, 200, { ok: true, duplicate: true, ref: dup.ref });

    const lead = dbm.createLead({
      source: body.source || 'web_form',
      utm_source: body.utm_source, utm_medium: body.utm_medium, utm_campaign: body.utm_campaign,
      utm_content: body.utm_content, utm_term: body.utm_term,
      page: body.page,
      vid: body.vid, gclid: body.gclid, fbclid: body.fbclid,
      landing_page: body.landing_page || body.page, referrer: body.referrer,
      self_reported: body.self_reported,
      first_touch: body.first_touch ? JSON.stringify(body.first_touch) : null,
      last_touch: body.last_touch ? JSON.stringify(body.last_touch) : null,
      name: body.name, phone: body.phone, email: body.email,
      locality: body.locality, postal_code: body.postal_code,
      client_type: body.client_type === 'empresa' ? 'empresa' : 'particular',
      product: PRODUCTS.includes(body.product) ? body.product : (body.product || null),
      message: body.message,
    }, null, clientIp(req));

    dbm.logEvent(lead.id, null, 'webhook', `Entrada automática desde web (${ident})`);
    return json(res, 201, { ok: true, ref: lead.ref, id: lead.id });
  }

  /* --- a partir de aquí, autenticado --- */
  if (!user) return json(res, 401, { error: 'No autenticado' });

  /* --- metadatos --- */
  if (pathname === '/api/meta' && method === 'GET') {
    const commercials = dbm.db.prepare("SELECT id, name, username, role FROM users WHERE active = 1 AND role IN ('comercial','admin') ORDER BY name").all();
    return json(res, 200, {
      sources: SOURCES, products: PRODUCTS, statuses: ALL_STATUSES,
      commercials,
      role: user.role,
      commission_rate: Number(dbm.getSetting('commission_rate', '0.05')),
    });
  }

  /* --- leads --- */
  if (pathname === '/api/leads' && method === 'GET') {
    const rows = dbm.listLeads({
      status: query.get('status'), month: query.get('month'), q: query.get('q'),
      source: query.get('source'), product: query.get('product'),
      commercial_id: query.get('commercial_id'),
      limit: query.get('limit'), offset: query.get('offset'),
    }, user);

    const out = rows.map(r => sanitizeLead(r, user));
    return json(res, 200, { leads: out, count: out.length });
  }

  if (pathname === '/api/leads' && method === 'POST') {
    if (!['admin', 'central'].includes(user.role)) {
      return json(res, 403, { error: 'Tu rol no puede crear leads' });
    }
    const body = await readBody(req);
    if (!body || (!body.phone && !body.email && !body.name)) {
      return json(res, 400, { error: 'Necesito al menos nombre, teléfono o email' });
    }
    const lead = dbm.createLead({
      source: SOURCES.includes(body.source) ? body.source : 'telefono',
      name: body.name, phone: body.phone, email: body.email,
      locality: body.locality, postal_code: body.postal_code,
      client_type: body.client_type === 'empresa' ? 'empresa' : 'particular',
      product: body.product || null,
      message: body.message, notes: body.notes,
      appointment_at: body.appointment_at || null,
      commercial_id: num(body.commercial_id),
    }, user.id, clientIp(req));
    return json(res, 201, { lead: sanitizeLead(lead, user) });
  }

  const m = pathname.match(/^\/api\/leads\/(\d+)$/);
  if (m && method === 'GET') {
    const lead = dbm.getLead(m[1]);
    if (!lead) return json(res, 404, { error: 'Lead no encontrado' });
    if (user.role === 'comercial' && lead.commercial_id !== user.id) {
      return json(res, 403, { error: 'Este lead no está asignado a ti' });
    }
    const events = dbm.db.prepare(`
      SELECT e.*, u.name AS user_name FROM lead_events e
      LEFT JOIN users u ON u.id = e.user_id
      WHERE e.lead_id = ? ORDER BY e.at DESC LIMIT 100
    `).all(lead.id);
    return json(res, 200, { lead: sanitizeLead(lead, user), events });
  }

  if (m && method === 'PATCH') {
    const lead = dbm.getLead(m[1]);
    if (!lead) return json(res, 404, { error: 'Lead no encontrado' });
    if (user.role === 'comercial' && lead.commercial_id !== user.id) {
      return json(res, 403, { error: 'Este lead no está asignado a ti' });
    }

    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'Cuerpo inválido' });

    if (body.status) {
      if (!ALL_STATUSES.includes(body.status)) return json(res, 400, { error: 'Estado inválido' });
      if (user.role === 'central' && !dbm.CENTRAL_STATUSES.includes(body.status)) {
        return json(res, 403, { error: 'La central no puede marcar ese estado' });
      }
      if (user.role === 'comercial' && !dbm.COMERCIAL_STATUSES.includes(body.status)) {
        return json(res, 403, { error: 'El comercial no puede marcar ese estado' });
      }
      if (!dbm.canTransition(lead.status, body.status, user.role)) {
        return json(res, 400, {
          error: `No se puede pasar de "${lead.status}" a "${body.status}" sin cumplir las fases del embudo`,
        });
      }
    }

    for (const f of ['quoted_amount', 'invoiced_amount', 'commission_rate', 'priority']) {
      if (f in body) body[f] = f === 'priority' ? Number(body.priority) || 0 : num(body[f]);
    }

    const result = dbm.updateLead(lead.id, body, user.id, user.role);
    return json(res, 200, { lead: sanitizeLead(result.lead, user), changes: result.changes });
  }

  const mNote = pathname.match(/^\/api\/leads\/(\d+)\/note$/);
  if (mNote && method === 'POST') {
    const lead = dbm.getLead(mNote[1]);
    if (!lead) return json(res, 404, { error: 'Lead no encontrado' });
    if (user.role === 'comercial' && lead.commercial_id !== user.id) {
      return json(res, 403, { error: 'Este lead no está asignado a ti' });
    }
    const body = await readBody(req);
    if (!body || !String(body.text || '').trim()) return json(res, 400, { error: 'Nota vacía' });
    dbm.logEvent(lead.id, user.id, 'nota', String(body.text).slice(0, 2000));
    dbm.db.prepare('UPDATE leads SET updated_at = ? WHERE id = ?').run(dbm.now(), lead.id);
    return json(res, 200, { ok: true });
  }

  /* --- estadísticas --- */
  if (pathname === '/api/traffic' && method === 'GET') {
    const month = query.get('month') || new Date().toISOString().slice(0, 7);
    return json(res, 200, dbm.trafficStats(month));
  }

  if (pathname === '/api/spend' && method === 'POST') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Solo el administrador' });
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'Cuerpo inválido' });
    return json(res, 200, dbm.spendUpsert(body));
  }

  if (pathname.startsWith('/api/spend/') && method === 'DELETE') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Solo el administrador' });
    const id = Number(pathname.split('/').pop());
    if (!id) return json(res, 400, { error: 'Id inválido' });
    return json(res, 200, dbm.spendDelete(id));
  }

  if (pathname === '/api/stats' && method === 'GET') {
    const s = dbm.stats(query.get('month'));
    if (user.role === 'central') { delete s.commission; delete s.invoiced; delete s.ticket; }
    return json(res, 200, s);
  }

  if (pathname === '/api/months' && method === 'GET') {
    return json(res, 200, { months: dbm.listMonths() });
  }

  /* --- usuarios (solo admin) --- */
  if (pathname === '/api/users' && method === 'GET') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Solo administradores' });
    const rows = dbm.db.prepare('SELECT id, username, name, role, phone, active, created_at FROM users ORDER BY role, name').all();
    return json(res, 200, { users: rows });
  }

  if (pathname === '/api/users' && method === 'POST') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Solo administradores' });
    const body = await readBody(req);
    if (!body || !body.username || !body.password || !body.name || !body.role) {
      return json(res, 400, { error: 'Faltan campos obligatorios' });
    }
    if (!['admin', 'central', 'comercial'].includes(body.role)) {
      return json(res, 400, { error: 'Rol inválido' });
    }
    if (String(body.password).length < 8) {
      return json(res, 400, { error: 'La contraseña debe tener al menos 8 caracteres' });
    }
    const username = String(body.username).trim().toLowerCase();
    if (dbm.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      return json(res, 409, { error: 'Ese usuario ya existe' });
    }
    const info = dbm.db.prepare('INSERT INTO users(username,password_hash,name,role,phone,active,created_at) VALUES(?,?,?,?,?,1,?)')
      .run(username, auth.hashPassword(body.password), String(body.name), body.role, body.phone || null, dbm.now());
    dbm.audit(user.id, 'usuario', `Alta de usuario ${username} (${body.role})`);
    return json(res, 201, { id: Number(info.lastInsertRowid) });
  }

  const mUser = pathname.match(/^\/api\/users\/(\d+)$/);
  if (mUser && method === 'PATCH') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Solo administradores' });
    const body = await readBody(req);
    const id = Number(mUser[1]);
    if (body.password) {
      if (String(body.password).length < 8) return json(res, 400, { error: 'Mínimo 8 caracteres' });
      dbm.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(body.password), id);
    }
    if (body.name) dbm.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(body.name), id);
    if (body.phone !== undefined) dbm.db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(body.phone || null, id);
    if (body.role && ['admin', 'central', 'comercial'].includes(body.role)) {
      dbm.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role, id);
    }
    if (body.active !== undefined) {
      if (id === user.id && !body.active) return json(res, 400, { error: 'No puedes desactivarte a ti mismo' });
      dbm.db.prepare('UPDATE users SET active = ? WHERE id = ?').run(body.active ? 1 : 0, id);
    }
    return json(res, 200, { ok: true });
  }

  /* --- exportación --- */
  if (pathname === '/api/export.csv' && method === 'GET') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Solo administradores' });
    const rows = dbm.listLeads({
      status: query.get('status'), month: query.get('month'), q: query.get('q'),
      limit: 100000, offset: 0,
    }, user);

    const cols = ['ref', 'created_at', 'source', 'utm_source', 'utm_campaign', 'name', 'phone', 'email',
      'locality', 'client_type', 'product', 'status', 'commercial_id', 'appointment_at',
      'quoted_amount', 'invoiced_amount', 'invoiced_at', 'invoice_ref', 'commission_rate', 'notes', 'lost_reason'];

    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [cols.join(';')];
    for (const r of rows) lines.push(cols.map(c => esc(r[c])).join(';'));
    // BOM para que Excel abra bien los acentos
    const csv = '\uFEFF' + lines.join('\r\n');
    const filename = `activemur-leads-${query.get('month') || 'todos'}.csv`;
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    });
    return res.end(csv);
  }

  return json(res, 404, { error: 'Ruta no encontrada' });
}

/**
 * Oculta importes y comisiones a quien no debe verlos.
 */
function sanitizeLead(lead, user) {
  if (!lead) return lead;
  const out = { ...lead };
  if (user.role === 'central') {
    delete out.quoted_amount;
    delete out.invoiced_amount;
    delete out.invoiced_at;
    delete out.invoice_ref;
    delete out.commission_rate;
  }
  if (user.role !== 'admin') {
    delete out.commission_amount;
  }
  return out;
}

/* ---------------- servidor ---------------- */

const server = http.createServer(async (req, res) => {
  let parsed;
  try {
    parsed = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400); return res.end('URL inválida');
  }
  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    res.writeHead(400); return res.end('Ruta inválida');
  }

  if (pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, pathname, parsed.searchParams);
    } catch (err) {
      console.error('[api]', err.message);
      if (!res.headersSent) json(res, 500, { error: 'Error interno' });
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);

  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Método no permitido');
});

server.listen(PORT, HOST, () => {
  auth.purgeExpired();
  console.log(`CRM Activemur escuchando en http://${HOST}:${PORT}`);
  console.log(`BD: ${dbm.DB_PATH}`);
  console.log(`Webhook: ${WEBHOOK_TOKEN ? 'configurado' : 'SIN TOKEN (desactivado)'}`);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
