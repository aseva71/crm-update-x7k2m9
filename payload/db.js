'use strict';
/**
 * Capa de datos del CRM Activemur.
 * SQLite nativo de Node (node:sqlite) — sin dependencias externas.
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.CRM_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.CRM_DB || path.join(DATA_DIR, 'crm.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

const now = () => new Date().toISOString();

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','central','comercial')),
  phone         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip         TEXT,
  ua         TEXT
);

CREATE TABLE IF NOT EXISTS leads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ref             TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'web_form',
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  utm_content     TEXT,
  utm_term        TEXT,
  page            TEXT,
  name            TEXT,
  phone           TEXT,
  email           TEXT,
  locality        TEXT,
  postal_code     TEXT,
  client_type     TEXT NOT NULL DEFAULT 'particular',
  product         TEXT,
  message         TEXT,
  status          TEXT NOT NULL DEFAULT 'nuevo'
                  CHECK (status IN ('nuevo','contactado','cita','visitado','presupuestado','ganado','perdido','descartado')),
  priority        INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  commercial_id   INTEGER REFERENCES users(id),
  appointment_at  TEXT,
  visited_at      TEXT,
  quoted_amount   REAL,
  invoiced_amount REAL,
  invoiced_at     TEXT,
  invoice_ref     TEXT,
  commission_rate REAL NOT NULL DEFAULT 0.05,
  lost_reason     TEXT,
  created_by      INTEGER REFERENCES users(id),
  ip              TEXT
);

CREATE TABLE IF NOT EXISTS lead_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  at      TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  type    TEXT NOT NULL,
  detail  TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  type    TEXT NOT NULL,
  detail  TEXT
);

CREATE TABLE IF NOT EXISTS visits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  vid          TEXT NOT NULL,
  at           TEXT NOT NULL,
  day          TEXT NOT NULL,
  event        TEXT NOT NULL,
  path         TEXT,
  referrer     TEXT,
  host         TEXT,
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  utm_content  TEXT,
  utm_term     TEXT,
  gclid        TEXT,
  fbclid       TEXT,
  device       TEXT,
  consent      INTEGER NOT NULL DEFAULT 0,
  ip_hash      TEXT,
  ua           TEXT
);

CREATE TABLE IF NOT EXISTS ad_spend (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  month      TEXT NOT NULL,
  channel    TEXT NOT NULL,
  campaign   TEXT NOT NULL DEFAULT '',
  amount     REAL NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(month, channel, campaign)
);

CREATE INDEX IF NOT EXISTS idx_leads_status   ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_created  ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_leads_comm     ON leads(commercial_id);
CREATE INDEX IF NOT EXISTS idx_events_lead    ON lead_events(lead_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp   ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_visits_day     ON visits(day);
CREATE INDEX IF NOT EXISTS idx_visits_vid     ON visits(vid);
CREATE INDEX IF NOT EXISTS idx_visits_event   ON visits(event);
CREATE INDEX IF NOT EXISTS idx_spend_month    ON ad_spend(month);
`);

/* ---------- migraciones idempotentes (columnas nuevas en leads) ---------- */
const LEAD_COLUMNS = [
  ['vid', 'TEXT'],
  ['gclid', 'TEXT'],
  ['fbclid', 'TEXT'],
  ['msclkid', 'TEXT'],
  ['landing_page', 'TEXT'],
  ['referrer', 'TEXT'],
  ['self_reported', 'TEXT'],
  ['first_touch', 'TEXT'],
  ['last_touch', 'TEXT'],
];
{
  const existing = new Set(db.prepare('PRAGMA table_info(leads)').all().map(r => r.name));
  for (const [name, type] of LEAD_COLUMNS) {
    if (!existing.has(name)) db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${type}`);
  }
}

/* ---------- utilidades ---------- */

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}

function nextRef() {
  const year = new Date().getFullYear();
  const prefix = `ACT-${year}-`;
  const row = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE ref LIKE ?").get(prefix + '%');
  let seq = (row.n || 0) + 1;
  let ref = prefix + String(seq).padStart(4, '0');
  // por si hay huecos o borrados manuales en BD
  while (db.prepare('SELECT 1 FROM leads WHERE ref = ?').get(ref)) {
    seq++;
    ref = prefix + String(seq).padStart(4, '0');
  }
  return ref;
}

function logEvent(leadId, userId, type, detail) {
  db.prepare('INSERT INTO lead_events(lead_id,at,user_id,type,detail) VALUES(?,?,?,?,?)')
    .run(leadId, now(), userId || null, type, detail ? String(detail) : null);
}

/** Eventos del sistema (accesos, altas de usuario, cambios de contraseña). */
function audit(userId, type, detail) {
  db.prepare('INSERT INTO audit_log(at,user_id,type,detail) VALUES(?,?,?,?)')
    .run(now(), userId || null, type, detail ? String(detail) : null);
}


/* ---------- leads ---------- */

const LEAD_FIELDS = [
  'source', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'page',
  'name', 'phone', 'email', 'locality', 'postal_code', 'client_type', 'product', 'message',
  'status', 'priority', 'notes', 'commercial_id', 'appointment_at', 'visited_at',
  'quoted_amount', 'invoiced_amount', 'invoiced_at', 'invoice_ref', 'commission_rate',
  'lost_reason',
];

/* Campos que se escriben al crear pero no se editan a mano (trazabilidad). */
const CREATE_ONLY = ['vid', 'gclid', 'fbclid', 'msclkid', 'landing_page', 'referrer',
                     'self_reported', 'first_touch', 'last_touch'];

function createLead(data, userId, ip) {
  const t = now();
  const ref = nextRef();
  const rate = data.commission_rate != null ? Number(data.commission_rate) : Number(getSetting('commission_rate', '0.05'));

  const cols = ['ref', 'created_at', 'updated_at', 'commission_rate', 'created_by', 'ip'];
  const vals = [ref, t, t, rate, userId || null, ip || null];

  for (const f of [...LEAD_FIELDS, ...CREATE_ONLY]) {
    if (f === 'status' || f === 'priority' || f === 'commission_rate') continue;
    if (data[f] !== undefined && data[f] !== null && data[f] !== '') {
      cols.push(f);
      vals.push(data[f]);
    }
  }
  if (data.status) { cols.push('status'); vals.push(data.status); }

  const sql = `INSERT INTO leads(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`;
  const info = db.prepare(sql).run(...vals);
  const id = Number(info.lastInsertRowid);
  logEvent(id, userId, 'creado', `Lead ${ref} creado (${data.source || 'web_form'})`);
  return getLead(id);
}

function getLead(id) {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(id)) || null;
}

function getLeadByRef(ref) {
  return db.prepare('SELECT * FROM leads WHERE ref = ?').get(String(ref)) || null;
}

/**
 * Lista de leads con filtros y visibilidad por rol.
 * admin/central ven todo; comercial solo los suyos.
 */
function listLeads(opts, viewer) {
  const where = [];
  const args = [];

  if (viewer.role === 'comercial') {
    where.push('commercial_id = ?');
    args.push(viewer.id);
  } else if (opts.commercial_id) {
    where.push('commercial_id = ?');
    args.push(Number(opts.commercial_id));
  }

  if (opts.status && opts.status !== 'todos') {
    if (opts.status === 'abiertos') {
      where.push("status NOT IN ('ganado','perdido','descartado')");
    } else if (opts.status.includes(',')) {
      const parts = opts.status.split(',').filter(Boolean);
      where.push(`status IN (${parts.map(() => '?').join(',')})`);
      args.push(...parts);
    } else {
      where.push('status = ?');
      args.push(opts.status);
    }
  }

  if (opts.month) { where.push("substr(created_at,1,7) = ?"); args.push(opts.month); }
  if (opts.source) { where.push('source = ?'); args.push(opts.source); }
  if (opts.product) { where.push('product = ?'); args.push(opts.product); }

  if (opts.q) {
    where.push('(name LIKE ? OR phone LIKE ? OR email LIKE ? OR ref LIKE ? OR locality LIKE ?)');
    const like = '%' + opts.q + '%';
    args.push(like, like, like, like, like);
  }

  const sql = `SELECT * FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?`;
  args.push(Number(opts.limit || 200), Number(opts.offset || 0));
  return db.prepare(sql).all(...args);
}

/**
 * Actualiza campos permitidos. No permite borrar leads (inmutabilidad del registro).
 */
function updateLead(id, data, userId, userRole) {
  const current = getLead(id);
  if (!current) return null;

  const allowed = FIELD_PERMISSIONS[userRole] || [];
  const sets = [];
  const args = [];
  const changes = [];

  for (const f of LEAD_FIELDS) {
    if (!(f in data)) continue;
    if (!allowed.includes(f)) continue;
    if (data[f] === current[f]) continue;

    sets.push(`${f} = ?`);
    args.push(data[f] === '' ? null : data[f]);
    changes.push(`${f}: ${current[f] ?? '—'} → ${data[f] ?? '—'}`);
  }

  if (!sets.length) return { lead: current, changes: [] };

  // Al pasar a ganado, fijar importe y comisión si no vienen
  if (data.status === 'ganado' && current.status !== 'ganado') {
    if (!sets.some(s => s.startsWith('invoiced_at'))) {
      sets.push('invoiced_at = ?');
      args.push(now());
    }
  }

  sets.push('updated_at = ?');
  args.push(now());
  args.push(Number(id));

  db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...args);

  if (changes.length) {
    const tipo = data.status && data.status !== current.status ? 'estado' : 'edicion';
    logEvent(id, userId, tipo, changes.join(' | '));
  }
  return { lead: getLead(id), changes };
}

/* Permisos por rol — qué campos puede tocar cada uno */
const FIELD_PERMISSIONS = {
  admin: LEAD_FIELDS,
  central: ['notes', 'status', 'priority', 'appointment_at', 'commercial_id',
            'name', 'phone', 'email', 'locality', 'postal_code', 'product',
            'client_type', 'message', 'source', 'lost_reason'],
  comercial: ['notes', 'status', 'visited_at', 'quoted_amount', 'invoiced_amount',
              'invoiced_at', 'invoice_ref', 'lost_reason'],
};

const CENTRAL_STATUSES = ['contactado', 'cita', 'descartado', 'nuevo', 'perdido'];
const COMERCIAL_STATUSES = ['visitado', 'presupuestado', 'ganado', 'perdido'];

/* Transiciones válidas del embudo (el administrador puede forzar cualquier cambio) */
const TRANSITIONS = {
  nuevo: ['contactado', 'cita', 'descartado', 'perdido'],
  contactado: ['cita', 'descartado', 'perdido', 'nuevo'],
  cita: ['visitado', 'presupuestado', 'ganado', 'descartado', 'perdido', 'contactado'],
  visitado: ['presupuestado', 'ganado', 'perdido', 'cita'],
  presupuestado: ['ganado', 'perdido', 'visitado'],
  ganado: ['perdido'],
  perdido: ['nuevo', 'contactado'],
  descartado: ['nuevo', 'contactado'],
};

function canTransition(from, to, role) {
  if (from === to) return true;
  if (role === 'admin') return true;
  return (TRANSITIONS[from] || []).includes(to);
}

/* ---------- estadísticas ---------- */

function stats(month) {
  const m = month || new Date().toISOString().slice(0, 7);
  const inMonth = db.prepare("SELECT * FROM leads WHERE substr(created_at,1,7) = ?").all(m);

  const byStatus = {};
  const bySource = {};
  const byProduct = {};
  for (const l of inMonth) {
    byStatus[l.status] = (byStatus[l.status] || 0) + 1;
    bySource[l.source] = (bySource[l.source] || 0) + 1;
    if (l.product) byProduct[l.product] = (byProduct[l.product] || 0) + 1;
  }

  const won = inMonth.filter(l => l.status === 'ganado');
  const invoiced = won.reduce((s, l) => s + (l.invoiced_amount || 0), 0);
  const commission = won.reduce((s, l) => s + (l.invoiced_amount || 0) * (l.commission_rate ?? 0.05), 0);

  // embudo sobre todos los leads del mes
  const total = inMonth.length;
  const contacted = inMonth.filter(l => l.status !== 'nuevo').length;
  const appointed = inMonth.filter(l => ['cita', 'visitado', 'presupuestado', 'ganado'].includes(l.status)).length;
  const visited = inMonth.filter(l => ['visitado', 'presupuestado', 'ganado'].includes(l.status)).length;

  return {
    month: m,
    total,
    byStatus,
    bySource,
    byProduct,
    contacted,
    appointed,
    visited,
    won: won.length,
    lost: inMonth.filter(l => l.status === 'perdido').length,
    invoiced,
    commission,
    rate_contact: total ? contacted / total : 0,
    rate_appoint: total ? appointed / total : 0,
    rate_visit: total ? visited / total : 0,
    rate_close: visited ? won.length / visited : 0,
    ticket: won.length ? invoiced / won.length : 0,
  };
}

/* ---------- tráfico y atribución ---------- */

const MAX = { vid: 64, event: 40, path: 300, referrer: 400, host: 120, utm: 160, click: 400 };

function cut(v, n) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, n) : null;
}

function trackEvent(d) {
  const at = d.at ? new Date(d.at) : new Date();
  const iso = (isNaN(at) ? new Date() : at).toISOString();
  const row = {
    vid: cut(d.vid, MAX.vid) || 'anon',
    at: iso,
    day: iso.slice(0, 10),
    event: cut(d.event, MAX.event) || 'page_view',
    path: cut(d.path, MAX.path),
    referrer: cut(d.referrer, MAX.referrer),
    host: cut(d.host, MAX.host),
    utm_source: cut(d.utm_source, MAX.utm),
    utm_medium: cut(d.utm_medium, MAX.utm),
    utm_campaign: cut(d.utm_campaign, MAX.utm),
    utm_content: cut(d.utm_content, MAX.utm),
    utm_term: cut(d.utm_term, MAX.utm),
    gclid: cut(d.gclid, MAX.click),
    fbclid: cut(d.fbclid, MAX.click),
    device: cut(d.device, 20),
    consent: d.consent ? 1 : 0,
    ip_hash: cut(d.ip_hash, 64),
    ua: cut(d.ua, 300),
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO visits(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`)
    .run(...cols.map(k => row[k]));
  return row;
}

/** Canal normalizado: el mismo criterio para visitas y leads. */
function channelOf(x = {}) {
  const src = (x.utm_source || '').toLowerCase();
  const med = (x.utm_medium || '').toLowerCase();
  const ref = (x.referrer || '').toLowerCase();
  if (x.gclid) return 'google-ads';
  if (med === 'cpc' || med === 'ppc' || med === 'paid' || med === 'paidsearch' || med === 'sem') {
    return src ? `${src}-ads` : 'paid-search';
  }
  if (med === 'email' || med === 'newsletter') return 'email';
  if (med === 'social' || med === 'organic-social') return src || 'social';
  if (med === 'referral') return src || 'referidos';
  if (ref.includes('google.')) return 'seo-google';
  if (ref.includes('bing.')) return 'seo-bing';
  if (ref.includes('instagram') || ref.includes('facebook') || ref.includes('t.co') || ref.includes('linkedin')) return 'social-organico';
  if (ref && !ref.includes('activemur')) {
    try { return new URL(ref).hostname.replace(/^www\./, ''); } catch { return 'referido'; }
  }
  if (x.source && x.source !== 'web_form') return x.source;
  if (src) return src;
  return 'directo';
}

function spendList(month) {
  const m = month || new Date().toISOString().slice(0, 7);
  return db.prepare('SELECT * FROM ad_spend WHERE month = ? ORDER BY amount DESC, channel').all(m);
}

function spendUpsert(d) {
  const month = cut(d.month, 7) || new Date().toISOString().slice(0, 7);
  const channel = cut(d.channel, 60) || 'google-ads';
  const campaign = cut(d.campaign, 120) || '';
  const amount = Math.max(0, Number(d.amount) || 0);
  db.prepare(`INSERT INTO ad_spend(month,channel,campaign,amount,note,created_at)
              VALUES(?,?,?,?,?,?)
              ON CONFLICT(month,channel,campaign) DO UPDATE SET amount=excluded.amount, note=excluded.note`)
    .run(month, channel, campaign, amount, cut(d.note, 300), now());
  return { ok: true };
}

function spendDelete(id) {
  db.prepare('DELETE FROM ad_spend WHERE id = ?').run(Number(id));
  return { ok: true };
}

/**
 * Panel de tráfico del mes: visitas, canales, conversión, gasto y economía.
 * Todo se calcula desde filas; nunca se suman conversiones de plataformas externas.
 */
function trafficStats(month) {
  const m = month || new Date().toISOString().slice(0, 7);
  const visits = db.prepare("SELECT * FROM visits WHERE substr(day,1,7) = ?").all(m);
  const leads = db.prepare("SELECT * FROM leads WHERE substr(created_at,1,7) = ?").all(m);
  const spend = spendList(m);

  const pageviews = visits.filter(v => v.event === 'page_view');
  const vids = new Set(pageviews.map(v => v.vid));
  const events = {};
  const byDay = {};
  const byChannel = {};
  const byPath = {};

  const bump = (obj, k) => { obj[k] = (obj[k] || 0) + 1; };

  for (const v of visits) {
    bump(events, v.event);
    if (v.event === 'page_view') {
      bump(byDay, v.day);
      bump(byChannel, channelOf(v));
      if (v.path) bump(byPath, v.path.split('?')[0]);
    }
  }

  // Serie diaria completa (días sin datos = 0)
  const [yy, mm] = m.split('-').map(Number);
  const daysInMonth = new Date(yy, mm, 0).getDate();
  const today = new Date();
  const lastDay = (today.getFullYear() === yy && today.getMonth() + 1 === mm)
    ? today.getDate() : daysInMonth;
  const series = [];
  for (let d = 1; d <= lastDay; d++) {
    const key = `${m}-${String(d).padStart(2, '0')}`;
    series.push({ day: key, visits: byDay[key] || 0, users: 0, leads: 0 });
  }
  for (const l of leads) {
    const key = String(l.created_at).slice(0, 10);
    const row = series.find(s => s.day === key);
    if (row) row.leads += 1;
  }

  // Leads por canal
  const leadsByChannel = {};
  for (const l of leads) bump(leadsByChannel, channelOf(l));

  const channels = Array.from(new Set([...Object.keys(byChannel), ...Object.keys(leadsByChannel)]))
    .map(ch => {
      const v = byChannel[ch] || 0;
      const ld = leadsByChannel[ch] || 0;
      const sp = spend.filter(s => s.channel === ch).reduce((a, b) => a + (b.amount || 0), 0);
      return {
        channel: ch, visits: v, leads: ld,
        conversion: v ? ld / v : null,
        spend: sp,
        cpl: (ld && sp > 0) ? sp / ld : null,
      };
    })
    .sort((a, b) => (b.visits + b.leads * 5) - (a.visits + a.leads * 5));

  const totalSpend = spend.reduce((a, b) => a + (b.amount || 0), 0);
  const won = leads.filter(l => l.status === 'ganado');
  const webLeads = leads.filter(l => l.vid);
  const invoiced = won.reduce((a, l) => a + (l.invoiced_amount || 0), 0);
  const commission = won.reduce((a, l) => a + (l.invoiced_amount || 0) * (l.commission_rate ?? 0.05), 0);

  return {
    month: m,
    visits: pageviews.length,
    users: vids.size,
    leads: leads.length,
    webLeads: webLeads.length,
    qualified: leads.filter(l => ['cita', 'visitado', 'presupuestado', 'ganado'].includes(l.status)).length,
    conversion: vids.size ? webLeads.length / vids.size : 0,
    events,
    channels,
    topPages: Object.entries(byPath).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([path, n]) => ({ path, views: n })),
    series,
    spend,
    economy: {
      spend: totalSpend,
      invoiced,
      commission,
      won: won.length,
      cpl: leads.length ? totalSpend / leads.length : null,
      cpa: won.length ? totalSpend / won.length : null,
      roas: totalSpend ? invoiced / totalSpend : null,
      margin: commission - totalSpend,
    },
  };
}

function listMonths() {
  const rows = db.prepare("SELECT DISTINCT substr(created_at,1,7) AS m FROM leads ORDER BY m DESC").all();
  return rows.map(r => r.m);
}

module.exports = {
  db, now, DB_PATH, DATA_DIR,
  getSetting, setSetting, nextRef, logEvent, audit,
  createLead, getLead, getLeadByRef, listLeads, updateLead,
  stats, listMonths,
  trackEvent, channelOf, trafficStats, spendList, spendUpsert, spendDelete,
  LEAD_FIELDS, CREATE_ONLY, FIELD_PERMISSIONS, CENTRAL_STATUSES, COMERCIAL_STATUSES, TRANSITIONS, canTransition,
};
