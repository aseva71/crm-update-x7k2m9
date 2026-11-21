'use strict';
/* CRM Activemur — interfaz (vanilla JS, sin build) */

/* ---------------- etiquetas ---------------- */

const STATUS = {
  nuevo: 'Nuevo',
  contactado: 'Contactado',
  cita: 'Cita',
  visitado: 'Visitado',
  presupuestado: 'Presupuestado',
  ganado: 'Ganado',
  perdido: 'Perdido',
  descartado: 'Descartado',
};

const PRODUCTS = {
  osmosis: 'Ósmosis inversa',
  descalcificador: 'Descalcificador',
  fuente: 'Fuente de agua',
  enfriador: 'Enfriador',
  purificador_aire: 'Purificador de aire',
  filterqueen: 'FilterQueen',
  hidrogenacion: 'Hidrogenación',
  limpieza: 'Limpieza y desinfección',
  otro: 'Otro',
};

const SOURCES = {
  web_form: 'Web',
  whatsapp: 'WhatsApp',
  telefono: 'Teléfono',
  feria: 'Feria',
  referido: 'Referido',
  redes: 'Redes sociales',
  otro: 'Otro',
};

const ROLE = { admin: 'Administrador', central: 'Central de llamadas', comercial: 'Comercial' };

/* ---------------- utilidades ---------------- */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const money = (n) => n == null || n === '' ? '—'
  : new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Number(n));

const money2 = (n) => n == null ? '—'
  : new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(Number(n));

function fDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function fRelative(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'ahora';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  if (diff < 86400 * 7) return `hace ${Math.floor(diff / 86400)} d`;
  return fDate(iso);
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; }, 2600);
  setTimeout(() => el.remove(), 2950);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !/\/api\/login$/.test(path)) { showLogin(); throw new Error('Sesión expirada'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

/* ---------------- estado ---------------- */

const state = {
  user: null,
  meta: null,
  view: 'panel',
  month: new Date().toISOString().slice(0, 7),
  filters: { status: 'abiertos', q: '', commercial_id: '' },
  leads: [],
  kLeads: [],
  drawerLead: null,
};

/* ---------------- sesión ---------------- */

async function boot() {
  try {
    const { user } = await api('/api/me');
    await startApp(user);
  } catch {
    showLogin();
  }
}

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#loginError').hidden = true;
  $('#loginForm').reset();
}

async function startApp(user) {
  state.user = user;
  $('#login').hidden = true;
  $('#app').hidden = false;

  $('#userName').textContent = user.name;
  $('#userRole').textContent = ROLE[user.role] || user.role;
  $('#userAvatar').textContent = (user.name || '?').trim().charAt(0).toUpperCase();

  $('#navNuevo').hidden = user.role === 'comercial';
  $('#navComisiones').hidden = user.role !== 'admin';
  $('#navUsuarios').hidden = user.role !== 'admin';
  $('#navTrafico').hidden = user.role !== 'admin';

  const meta = await api('/api/meta');
  state.meta = meta;

  const { months } = await api('/api/months');
  const cur = new Date().toISOString().slice(0, 7);
  const list = Array.from(new Set([cur, ...months]));
  $('#monthSelect').innerHTML = list.map(m => {
    const [y, mo] = m.split('-');
    const label = new Date(Number(y), Number(mo) - 1, 1)
      .toLocaleDateString('es-ES', { month: 'short', year: 'numeric' });
    return `<option value="${m}" ${m === state.month ? 'selected' : ''}>${label}</option>`;
  }).join('');

  const fromHash = location.hash.replace('#', '');
  if (['panel', 'trafico', 'leads', 'kanban', 'nuevo', 'comisiones', 'usuarios', 'cuenta'].includes(fromHash)) {
    state.view = fromHash;
  }
  render();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const { user } = await api('/api/login', {
      method: 'POST',
      body: { username: f.get('username'), password: f.get('password') },
    });
    await startApp(user);
  } catch (err) {
    const el = $('#loginError');
    el.textContent = err.message;
    el.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  state.user = null;
  showLogin();
});

$('#monthSelect').addEventListener('change', (e) => {
  state.month = e.target.value;
  render();
});

$('#menuBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

$$('.nav-item').forEach(el => {
  el.addEventListener('click', () => {
    setView(el.dataset.view);
    $('#sidebar').classList.remove('open');
  });
});

function setView(v) {
  state.view = v;
  location.hash = v;
  render();
}

/* ---------------- render raíz ---------------- */

function render() {
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === state.view));
  const main = $('#main');

  if (state.view === 'panel') return renderPanel(main);
  if (state.view === 'trafico') return renderTrafico(main);
  if (state.view === 'leads') return renderLeads(main);
  if (state.view === 'kanban') return renderKanban(main);
  if (state.view === 'nuevo') return renderNuevo(main);
  if (state.view === 'comisiones') return renderComisiones(main);
  if (state.view === 'usuarios') return renderUsuarios(main);
  if (state.view === 'cuenta') return renderCuenta(main);
}

/* ---------------- panel ---------------- */

async function renderPanel(main) {
  main.innerHTML = `<div class="page-head"><div><h2>Panel</h2><p>Cargando…</p></div></div>`;
  const [s, { leads }] = await Promise.all([
    api('/api/stats?month=' + state.month),
    api('/api/leads?status=abiertos&limit=300'),
  ]);

  const isAdmin = state.user.role === 'admin';
  const mLabel = new Date(...state.month.split('-').map((v, i) => i === 0 ? Number(v) : Number(v) - 1)).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

  const pendientes = leads.filter(l => l.status === 'nuevo').length;
  const citas = leads.filter(l => l.status === 'cita').length;
  const retrasados = leads.filter(l => l.status === 'nuevo' && (Date.now() - new Date(l.created_at)) > 24 * 3600e3).length;

  const funnel = [
    ['Leads', s.total],
    ['Contactados', s.contacted],
    ['Citas', s.appointed],
    ['Visitas', s.visited],
    ['Ganados', s.won],
  ];
  const maxF = Math.max(1, ...funnel.map(f => f[1]));

  const srcRows = Object.entries(s.bySource || {}).sort((a, b) => b[1] - a[1]);
  const prodRows = Object.entries(s.byProduct || {}).sort((a, b) => b[1] - a[1]);

  main.innerHTML = `
    <div class="page-head">
      <div><h2>Panel</h2><p>Resumen de ${mLabel}</p></div>
      <button class="btn btn-primary" onclick="setView('nuevo')" ${state.user.role === 'comercial' ? 'hidden' : ''}>+ Nuevo lead</button>
    </div>

    <div class="kpi-grid">
      <div class="kpi"><div class="label">Leads</div><div class="value">${s.total}</div><div class="sub">entrados en el mes</div></div>
      <div class="kpi"><div class="label">Sin llamar</div><div class="value" style="color:${retrasados ? 'var(--danger)' : 'inherit'}">${pendientes}</div><div class="sub">${retrasados ? retrasados + ' con +24 h' : 'al día'}</div></div>
      <div class="kpi"><div class="label">Citas</div><div class="value">${s.appointed}</div><div class="sub">${citas} pendientes</div></div>
      <div class="kpi"><div class="label">Visitas</div><div class="value">${s.visited}</div><div class="sub">${pct(s.rate_visit)} sobre leads</div></div>
      <div class="kpi"><div class="label">Ganados</div><div class="value" style="color:var(--ok)">${s.won}</div><div class="sub">${pct(s.rate_close)} sobre visitas</div></div>
      ${isAdmin ? `
      <div class="kpi"><div class="label">Facturado</div><div class="value">${money(s.invoiced)}</div><div class="sub">ticket medio ${money(s.ticket)}</div></div>
      <div class="kpi accent"><div class="label">Tu comisión 5%</div><div class="value">${money2(s.commission)}</div><div class="sub">sobre ${s.won} ventas</div></div>` : ''}
    </div>

    <div class="card">
      <h3>Embudo del mes</h3>
      <div style="display:flex;flex-direction:column;gap:9px">
        ${funnel.map(([label, n]) => `
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:12.5px;color:var(--ink-2);width:100px;flex:0 0 100px">${label}</span>
            <div style="flex:1;background:#eef3f4;border-radius:6px;height:22px;overflow:hidden">
              <div style="width:${Math.max(2, (n / maxF) * 100)}%;height:100%;background:linear-gradient(90deg,#0f766e,#14a89c);border-radius:6px"></div>
            </div>
            <b style="width:34px;text-align:right;font-size:13.5px">${n}</b>
          </div>`).join('')}
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px">
      <div class="card">
        <h3>Por origen</h3>
        ${srcRows.length ? srcRows.map(([k, n]) => barRow(SOURCES[k] || k, n, s.total)).join('') : '<p style="color:var(--ink-3);font-size:13px">Sin datos este mes.</p>'}
      </div>
      <div class="card">
        <h3>Por producto</h3>
        ${prodRows.length ? prodRows.map(([k, n]) => barRow(PRODUCTS[k] || k, n, s.total)).join('') : '<p style="color:var(--ink-3);font-size:13px">Sin datos este mes.</p>'}
      </div>
    </div>

    <div class="card">
      <h3>Necesitan acción</h3>
      ${renderPendingList(leads)}
    </div>
  `;
}

function pct(n) { return Math.round((n || 0) * 100) + '%'; }

function barRow(label, n, total) {
  const p = total ? Math.round((n / total) * 100) : 0;
  return `<div style="display:flex;align-items:center;gap:9px;margin-bottom:7px">
    <span style="font-size:12.5px;color:var(--ink-2);width:112px;flex:0 0 112px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</span>
    <div style="flex:1;background:#eef3f4;border-radius:5px;height:8px"><div style="width:${p}%;height:100%;background:#14a89c;border-radius:5px"></div></div>
    <b style="font-size:12.5px;width:28px;text-align:right">${n}</b>
  </div>`;
}

function renderPendingList(leads) {
  const pend = leads.filter(l => ['nuevo', 'contactado', 'cita'].includes(l.status)).slice(0, 6);
  if (!pend.length) return '<p style="color:var(--ink-3);font-size:13px;margin:0">Nada pendiente. Todo al día.</p>';
  return pend.map(l => `
    <div onclick="openLead(${l.id})" style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);cursor:pointer">
      <span class="badge ${l.status}">${STATUS[l.status]}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.name || l.phone || l.email || 'Sin nombre')}</div>
        <div class="lead-sub">${esc(l.locality || '—')} · ${esc(PRODUCTS[l.product] || 'sin producto')}</div>
      </div>
      <span style="font-size:12px;color:var(--ink-3)">${fRelative(l.created_at)}</span>
    </div>`).join('');
}

/* ---------------- leads ---------------- */

/* ---------------- tráfico ---------------- */

async function renderTrafico(main) {
  main.innerHTML = '<div class="page-head"><div><h2>Tráfico</h2><p>Cargando…</p></div></div>';
  let t;
  try {
    t = await api('/api/traffic?month=' + state.month);
  } catch (err) {
    main.innerHTML = '<div class="card"><h3>Tráfico</h3><p>' + esc(err.message) + '</p></div>';
    return;
  }

  const [yy, mm] = state.month.split('-');
  const mLabel = new Date(Number(yy), Number(mm) - 1, 1)
    .toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  const eco = t.economy || {};
  const maxV = Math.max(1, ...t.series.map(s => s.visits));
  const fmt = (n, d) => n == null ? '—' : Number(n).toLocaleString('es-ES', { maximumFractionDigits: d == null ? 0 : d });
  const conv = (v) => v == null ? '—' : (v * 100).toFixed(1) + '%';

  const bars = t.series.map(s => {
    const h = Math.round((s.visits / maxV) * 118);
    return '<div title="' + s.day + ': ' + s.visits + ' visitas · ' + s.leads + ' leads" ' +
      'style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:3px;min-width:6px;height:100%">' +
      '<div style="width:100%;height:' + Math.max(3, h) + 'px;background:' + (s.leads ? '#0f766e' : '#cfe3e0') + ';border-radius:3px 3px 0 0"></div>' +
      '<span style="font-size:8px;color:var(--ink-3)">' + Number(s.day.slice(8)) + '</span></div>';
  }).join('');

  const chanRows = t.channels.length ? t.channels.map(c =>
    '<tr><td><b>' + esc(c.channel) + '</b></td>' +
    '<td>' + fmt(c.visits) + '</td>' +
    '<td>' + fmt(c.leads) + '</td>' +
    '<td>' + conv(c.conversion) + '</td>' +
    '<td>' + (c.spend ? money2(c.spend) : '—') + '</td>' +
    '<td>' + (c.cpl != null ? money2(c.cpl) : '—') + '</td></tr>'
  ).join('') : '<tr><td colspan="6" style="color:var(--ink-3)">Sin datos todavía. Instala track.js y empieza a recibir visitas.</td></tr>';

  const pageRows = t.topPages.length ? t.topPages.map(p =>
    '<tr><td style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(p.path) + '</td><td>' + fmt(p.views) + '</td></tr>'
  ).join('') : '<tr><td colspan="2" style="color:var(--ink-3)">Sin páginas registradas.</td></tr>';

  const evRows = Object.entries(t.events || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) =>
    '<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--line, #e6eef0);font-size:13px">' +
    '<span>' + esc(k) + '</span><b>' + fmt(n) + '</b></div>'
  ).join('') || '<p style="color:var(--ink-3);font-size:13px">Sin eventos.</p>';

  const spendRows = (t.spend || []).length ? t.spend.map(s =>
    '<tr><td>' + esc(s.channel) + '</td><td>' + esc(s.campaign || '—') + '</td>' +
    '<td>' + money2(s.amount) + '</td><td>' + esc(s.note || '') + '</td>' +
    '<td><button class="btn btn-sm" onclick="delSpend(' + s.id + ')">Quitar</button></td></tr>'
  ).join('') : '<tr><td colspan="5" style="color:var(--ink-3)">Sin gasto declarado este mes.</td></tr>';

  const chOptions = ['google-ads', 'meta-ads', 'seo', 'gbp', 'email', 'prospeccion', 'otro']
    .map(c => '<option value="' + c + '">' + c + '</option>').join('');

  main.innerHTML =
    '<div class="page-head"><div><h2>Tráfico y economía</h2><p>' + mLabel + ' · medición first-party del CRM</p></div>' +
    '<button class="btn btn-sm" onclick="render()">Actualizar</button></div>' +

    '<div class="kpi-grid">' +
      '<div class="kpi"><div class="label">Visitas</div><div class="value">' + fmt(t.visits) + '</div><div class="sub">' + fmt(t.users) + ' usuarios únicos</div></div>' +
      '<div class="kpi"><div class="label">Leads</div><div class="value">' + fmt(t.leads) + '</div><div class="sub">' + fmt(t.qualified) + ' cualificados</div></div>' +
      '<div class="kpi"><div class="label">Conversión</div><div class="value">' + conv(t.conversion) + '</div><div class="sub">' + fmt(t.webLeads) + ' leads web / usuarios</div></div>' +
      '<div class="kpi"><div class="label">Gasto</div><div class="value">' + money(eco.spend) + '</div><div class="sub">CPL ' + (eco.cpl != null ? money2(eco.cpl) : '—') + '</div></div>' +
      '<div class="kpi"><div class="label">Facturado</div><div class="value">' + money(eco.invoiced) + '</div><div class="sub">' + fmt(eco.won) + ' ventas · ROAS ' + (eco.roas != null ? eco.roas.toFixed(2) + '×' : '—') + '</div></div>' +
      '<div class="kpi accent"><div class="label">Comisión 5%</div><div class="value">' + money2(eco.commission) + '</div><div class="sub">margen ' + money2(eco.margin) + '</div></div>' +
    '</div>' +

    '<div class="card"><h3>Visitas por día</h3>' +
      '<div style="display:flex;align-items:flex-end;gap:3px;height:150px">' + bars + '</div>' +
      '<p style="margin:10px 0 0;font-size:12px;color:var(--ink-3)">Verde = día con leads. Visitas = page_view first-party; GA4 puede diferir por consentimiento y bloqueadores.</p>' +
    '</div>' +

    '<div class="card"><h3>Canales</h3><div class="table-wrap"><table class="data">' +
      '<thead><tr><th>Canal</th><th>Visitas</th><th>Leads</th><th>Conv.</th><th>Gasto</th><th>CPL</th></tr></thead>' +
      '<tbody>' + chanRows + '</tbody></table></div>' +
      '<p style="margin:10px 0 0;font-size:12px;color:var(--ink-3)">Canal calculado por <code>gclid</code> &gt; <code>utm_medium</code> &gt; referrer &gt; directo. El gasto se declara a mano abajo.</p>' +
    '</div>' +

    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px">' +
      '<div class="card"><h3>Páginas más vistas</h3><div class="table-wrap"><table class="data"><tbody>' + pageRows + '</tbody></table></div></div>' +
      '<div class="card"><h3>Eventos</h3>' + evRows + '</div>' +
    '</div>' +

    '<div class="card"><h3>Gasto publicitario del mes</h3>' +
      '<div class="form-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;align-items:end">' +
        '<div class="field"><label>Canal</label><select id="spChannel">' + chOptions + '</select></div>' +
        '<div class="field"><label>Campaña</label><input id="spCampaign" placeholder="osmosis-murcia"></div>' +
        '<div class="field"><label>Importe €</label><input id="spAmount" type="number" min="0" step="0.01" placeholder="300"></div>' +
        '<div class="field"><label>Nota</label><input id="spNote" placeholder="factura Google"></div>' +
        '<div class="field"><label>&nbsp;</label><button class="btn btn-primary" id="spSave">Añadir gasto</button></div>' +
      '</div>' +
      '<div class="table-wrap" style="margin-top:14px"><table class="data">' +
        '<thead><tr><th>Canal</th><th>Campaña</th><th>Importe</th><th>Nota</th><th></th></tr></thead>' +
        '<tbody>' + spendRows + '</tbody></table></div>' +
    '</div>';

  const btn = $('#spSave');
  if (btn) btn.addEventListener('click', async () => {
    try {
      await api('/api/spend', {
        method: 'POST',
        body: {
          month: state.month,
          channel: $('#spChannel').value,
          campaign: $('#spCampaign').value,
          amount: Number($('#spAmount').value || 0),
          note: $('#spNote').value,
        },
      });
      toast('Gasto guardado');
      render();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function delSpend(id) {
  try {
    await api('/api/spend/' + id, { method: 'DELETE' });
    toast('Gasto eliminado');
    render();
  } catch (err) { toast(err.message, 'error'); }
}

async function renderLeads(main) {
  const f = state.filters;
  main.innerHTML = `
    <div class="page-head"><div><h2>Leads</h2><p>Cargando…</p></div></div>`;

  const params = new URLSearchParams();
  params.set('status', f.status);
  if (f.q) params.set('q', f.q);
  if (f.commercial_id) params.set('commercial_id', f.commercial_id);
  params.set('limit', '300');

  const { leads } = await api('/api/leads?' + params.toString());
  state.leads = leads;

  const counts = {};
  for (const l of leads) counts[l.status] = (counts[l.status] || 0) + 1;

  const chips = [
    ['abiertos', 'Abiertos'],
    ['nuevo', 'Nuevo'],
    ['contactado', 'Contactado'],
    ['cita', 'Cita'],
    ['visitado', 'Visitado'],
    ['presupuestado', 'Presupuestado'],
    ['ganado', 'Ganado'],
    ['perdido', 'Perdido'],
    ['todos', 'Todos'],
  ];

  main.innerHTML = `
    <div class="page-head">
      <div><h2>Leads</h2><p>${leads.length} ${leads.length === 1 ? 'resultado' : 'resultados'}</p></div>
      <button class="btn btn-primary" onclick="setView('nuevo')" ${state.user.role === 'comercial' ? 'hidden' : ''}>+ Nuevo lead</button>
    </div>

    <div class="filters">
      <input type="search" id="searchInput" placeholder="Buscar por nombre, teléfono, email o referencia…" value="${esc(f.q)}">
      ${state.user.role !== 'comercial' ? `
      <select id="commFilter">
        <option value="">Todos los comerciales</option>
        ${(state.meta.commercials || []).map(c => `<option value="${c.id}" ${String(f.commercial_id) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>` : ''}
    </div>

    <div class="chips">
      ${chips.map(([k, label]) => `<button class="chip ${f.status === k ? 'active' : ''}" data-status="${k}">${label}${counts[k] ? `<span class="n">${counts[k]}</span>` : ''}</button>`).join('')}
    </div>

    <div class="lead-list" id="leadList">
      ${leads.length ? leads.map(leadRow).join('') : emptyLeads()}
    </div>
  `;

  $$('#leadList .lead-row').forEach(el => el.addEventListener('click', () => openLead(Number(el.dataset.id))));
  $$('.chip[data-status]').forEach(el => el.addEventListener('click', () => { state.filters.status = el.dataset.status; render(); }));

  let t;
  $('#searchInput').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.filters.q = e.target.value.trim(); renderLeads($('#main')); }, 300);
  });
  const cf = $('#commFilter');
  if (cf) cf.addEventListener('change', (e) => { state.filters.commercial_id = e.target.value; render(); });
}

function leadRow(l) {
  const shown = state.user.role === 'admin' ? (l.invoiced_amount ?? l.quoted_amount) : null;
  return `<div class="lead-row" data-id="${l.id}">
    <span class="lead-ref">${esc(l.ref)}</span>
    <div>
      <div class="lead-name">${esc(l.name || 'Sin nombre')}${l.priority ? '<span class="badge prio">prioritario</span>' : ''}</div>
      <div class="lead-sub">${esc(l.phone || l.email || '—')} · ${esc(l.locality || '—')} · ${esc(PRODUCTS[l.product] || 'sin producto')}</div>
    </div>
    <span class="lead-when" style="font-size:12.5px;color:var(--ink-3)">${l.appointment_at ? 'Cita: ' + fDateTime(l.appointment_at) : fRelative(l.created_at)}</span>
    <span class="badge ${l.status}">${STATUS[l.status]}</span>
    <div class="lead-amount">
      ${shown != null ? `<b>${money(shown)}</b>${l.invoiced_amount != null ? `<small>com. ${money2(l.invoiced_amount * (l.commission_rate ?? 0.05))}</small>` : ''}` : `<span style="color:var(--ink-3);font-size:12.5px">${esc(SOURCES[l.source] || '')}</span>`}
    </div>
  </div>`;
}

function emptyLeads() {
  return `<div class="empty">
    <h4>No hay leads con estos filtros</h4>
    <p style="margin:0">Prueba a cambiar el estado o el buscador.</p>
  </div>`;
}

/* ---------------- embudo (kanban) ---------------- */

const COLUMNS = [
  { key: 'nuevo', label: 'Nuevo', color: '#8b9aa4' },
  { key: 'contactado', label: 'Contactado', color: '#1d4ed8' },
  { key: 'cita', label: 'Cita', color: '#6d28d9' },
  { key: 'visitado', label: 'Visitado', color: '#0369a1' },
  { key: 'presupuestado', label: 'Presupuestado', color: '#b45309' },
  { key: 'ganado', label: 'Ganado', color: '#15803d' },
  { key: 'sinventa', label: 'Sin venta', color: '#b91c1c' },
];

/* Movimientos permitidos desde cada estado */
const FLOW = {
  nuevo: ['contactado', 'cita', 'descartado', 'perdido'],
  contactado: ['cita', 'descartado', 'perdido'],
  cita: ['visitado', 'presupuestado', 'ganado', 'descartado', 'perdido'],
  visitado: ['presupuestado', 'ganado', 'perdido'],
  presupuestado: ['ganado', 'perdido'],
  ganado: ['perdido'],
  perdido: ['nuevo', 'contactado'],
  descartado: ['nuevo', 'contactado'],
};

const ROLE_TARGETS = {
  admin: null, // todos
  central: ['contactado', 'cita', 'descartado', 'perdido'],
  comercial: ['visitado', 'presupuestado', 'ganado', 'perdido'],
};

function canMove(lead, to) {
  if (!lead || lead.status === to) return false;
  const allowed = FLOW[lead.status] || [];
  if (!allowed.includes(to)) return false;
  const roleTargets = ROLE_TARGETS[state.user.role];
  if (roleTargets && !roleTargets.includes(to)) return false;
  return true;
}

async function renderKanban(main) {
  main.innerHTML = `<div class="page-head"><div><h2>Embudo</h2><p>Cargando…</p></div></div>`;

  const [{ leads: open }, { leads: closed }] = await Promise.all([
    api('/api/leads?status=abiertos&limit=500'),
    api('/api/leads?status=ganado,perdido,descartado&limit=120'),
  ]);

  state.kLeads = open.concat(closed);
  const isAdmin = state.user.role === 'admin';

  const byCol = {};
  for (const k of COLUMNS) byCol[k.key] = [];
  for (const l of state.kLeads) {
    if (l.status === 'perdido' || l.status === 'descartado') byCol.sinventa.push(l);
    else if (byCol[l.status]) byCol[l.status].push(l);
  }

  const totalOpen = open.length;
  const wonValue = (byCol.ganado || []).reduce((a, l) => a + (l.invoiced_amount || 0), 0);

  main.innerHTML = `
    <div class="page-head">
      <div><h2>Embudo</h2><p>${totalOpen} leads abiertos${isAdmin ? ` · ${money(wonValue)} ganados` : ''}</p></div>
      <button class="btn btn-primary" onclick="setView('nuevo')" ${state.user.role === 'comercial' ? 'hidden' : ''}>+ Nuevo lead</button>
    </div>
    <p style="font-size:12.5px;color:var(--ink-3);margin:-8px 0 14px">
      Arrastra las tarjetas entre columnas, o usa <b>Mover</b> en el móvil. Al pasar a Cita o Ganado se te pedirán los datos.
    </p>
    <div class="board-wrap">
      <div class="board" id="board">
        ${COLUMNS.map(col => {
          const items = byCol[col.key];
          const sum = isAdmin && col.key === 'ganado' ? items.reduce((a, l) => a + (l.invoiced_amount || 0), 0) : 0;
          return `<div class="col" data-col="${col.key}">
            <div class="col-head">
              <span class="dot" style="background:${col.color}"></span>
              ${col.label}
              ${sum ? `<span class="sum">${money(sum)}</span>` : ''}
              <span class="n">${items.length}</span>
            </div>
            <div class="col-body" data-drop="${col.key}">
              ${items.length ? items.map(kcard).join('') : '<div class="col-empty">—</div>'}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>
  `;

  wireBoard();
}

function kcard(l) {
  const isAdmin = state.user.role === 'admin';
  const showAmount = isAdmin && (l.invoiced_amount ?? l.quoted_amount) != null;
  const moves = (FLOW[l.status] || []).filter(t => canMove(l, t));
  const meta2 = [l.appointment_at ? 'Cita ' + fDateTime(l.appointment_at) : null, PRODUCTS[l.product] || null]
    .filter(Boolean).join(' · ');

  return `<div class="kcard" draggable="true" data-id="${l.id}" data-status="${l.status}">
    <div class="k-ref">${esc(l.ref)}${l.priority ? ' · prioritario' : ''}</div>
    <div class="k-name">${esc(l.name || 'Sin nombre')}</div>
    <div class="k-meta">${esc(l.phone || l.email || '—')}${l.locality ? ' · ' + esc(l.locality) : ''}</div>
    ${meta2 ? `<div class="k-meta">${esc(meta2)}</div>` : ''}
    <div class="k-foot">
      ${moves.length ? `<button class="k-move" data-menu="${l.id}">Mover</button>` : ''}
      ${showAmount ? `<span class="k-amount">${money(l.invoiced_amount ?? l.quoted_amount)}</span>` : ''}
    </div>
    ${moves.length ? `<div class="kmove" data-panel="${l.id}" hidden>
      ${moves.map(t => `<button data-go="${l.id}:${t}" class="${t === 'perdido' || t === 'descartado' ? 'danger' : ''}">${STATUS[t]}</button>`).join('')}
    </div>` : ''}
  </div>`;
}

let boardDragging = false;

function wireBoard() {
  const board = $('#board');
  if (!board) return;

  // abrir ficha / menú de mover
  board.addEventListener('click', (e) => {
    const menuBtn = e.target.closest('[data-menu]');
    if (menuBtn) {
      e.stopPropagation();
      const id = menuBtn.dataset.menu;
      const panel = board.querySelector(`[data-panel="${id}"]`);
      if (panel) panel.hidden = !panel.hidden;
      return;
    }
    const go = e.target.closest('[data-go]');
    if (go) {
      e.stopPropagation();
      const [id, status] = go.dataset.go.split(':');
      moveLead(Number(id), status);
      return;
    }
    if (boardDragging) return;
    const card = e.target.closest('.kcard');
    if (card) openLead(Number(card.dataset.id));
  });

  // arrastrar
  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.kcard');
    if (!card) return;
    boardDragging = true;
    card.classList.add('dragging');
    e.dataTransfer.setData('text/plain', card.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
  });

  board.addEventListener('dragend', () => {
    boardDragging = false;
    setTimeout(() => { boardDragging = false; }, 120);
    board.querySelectorAll('.kcard').forEach(c => c.classList.remove('dragging'));
    board.querySelectorAll('.col').forEach(c => c.classList.remove('drop-target'));
  });

  board.querySelectorAll('[data-drop]').forEach(body => {
    body.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      body.closest('.col').classList.add('drop-target');
    });
    body.addEventListener('dragleave', (e) => {
      if (!body.contains(e.relatedTarget)) body.closest('.col').classList.remove('drop-target');
    });
    body.addEventListener('drop', (e) => {
      e.preventDefault();
      body.closest('.col').classList.remove('drop-target');
      const id = Number(e.dataTransfer.getData('text/plain'));
      const col = body.dataset.drop;
      const lead = (state.kLeads || []).find(l => l.id === id);
      if (!lead) return;
      if (col === 'sinventa') return moveLead(id, 'perdido');
      moveLead(id, col);
    });
  });
}

async function moveLead(id, status) {
  const lead = (state.kLeads || []).find(l => l.id === id) || state.drawerLead;
  if (lead && !canMove(lead, status)) {
    toast('No puedes pasar de ' + (STATUS[lead.status] || '?') + ' a ' + (STATUS[status] || '?'), 'err');
    return;
  }
  // estados que necesitan datos: se piden en la ficha
  if (['cita', 'ganado', 'perdido', 'presupuestado'].includes(status)) {
    await openLead(id);
    advance(id, status);
    return;
  }
  try {
    await api('/api/leads/' + id, { method: 'PATCH', body: { status } });
    toast('Movido a ' + STATUS[status], 'ok');
    if (state.view === 'kanban') renderKanban($('#main'));
    else render();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---------------- detalle de lead (drawer) ---------------- */

async function openLead(id) {
  const { lead, events } = await api('/api/leads/' + id);
  state.drawerLead = lead;
  const d = $('#drawer');
  d.hidden = false;
  $('#overlay').hidden = false;

  const canEditContact = ['admin', 'central'].includes(state.user.role);
  const canAmounts = ['admin', 'comercial'].includes(state.user.role);

  d.innerHTML = `
    <div class="drawer-head">
      <div>
        <h3>${esc(lead.name || 'Sin nombre')}</h3>
        <div class="ref">${esc(lead.ref)} · alta ${fDateTime(lead.created_at)} · ${esc(SOURCES[lead.source] || lead.source)}</div>
      </div>
      <button class="btn btn-sm drawer-close" onclick="closeDrawer()">Cerrar</button>
    </div>
    <div class="drawer-body">
      <div id="actionPanel"></div>

      <div class="section-title">Estado</div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span class="badge ${lead.status}" style="font-size:13px;padding:5px 12px">${STATUS[lead.status]}</span>
        ${lead.commercial_id ? `<span style="font-size:12.5px;color:var(--ink-2)">Comercial: <b>${esc((state.meta.commercials.find(c => c.id === lead.commercial_id) || {}).name || '—')}</b></span>` : ''}
      </div>

      <div class="section-title">Acciones</div>
      <div class="actions">${actionButtons(lead)}</div>

      <div class="section-title">Datos</div>
      <div class="info-grid">
        <div class="item"><div class="k">Teléfono</div><div class="v">${lead.phone ? `<a href="tel:${esc(lead.phone)}">${esc(lead.phone)}</a>` : '—'}</div></div>
        <div class="item"><div class="k">Email</div><div class="v">${lead.email ? `<a href="mailto:${esc(lead.email)}">${esc(lead.email)}</a>` : '—'}</div></div>
        <div class="item"><div class="k">Localidad</div><div class="v">${esc(lead.locality || '—')} ${lead.postal_code ? esc(lead.postal_code) : ''}</div></div>
        <div class="item"><div class="k">Tipo</div><div class="v">${lead.client_type === 'empresa' ? 'Empresa' : 'Particular'}</div></div>
        <div class="item"><div class="k">Producto</div><div class="v">${esc(PRODUCTS[lead.product] || '—')}</div></div>
        <div class="item"><div class="k">Origen</div><div class="v">${esc(SOURCES[lead.source] || lead.source)}${lead.utm_source ? ` · ${esc(lead.utm_source)}` : ''}${lead.utm_campaign ? ` / ${esc(lead.utm_campaign)}` : ''}</div></div>
        ${lead.appointment_at ? `<div class="item"><div class="k">Cita</div><div class="v">${fDateTime(lead.appointment_at)}</div></div>` : ''}
        ${canAmounts && lead.quoted_amount != null ? `<div class="item"><div class="k">Presupuestado</div><div class="v">${money2(lead.quoted_amount)}</div></div>` : ''}
        ${canAmounts && lead.invoiced_amount != null ? `<div class="item"><div class="k">Facturado</div><div class="v">${money2(lead.invoiced_amount)}${lead.invoice_ref ? ' · ' + esc(lead.invoice_ref) : ''}</div></div>` : ''}
        ${state.user.role === 'admin' && lead.invoiced_amount != null ? `<div class="item"><div class="k">Tu comisión</div><div class="v" style="color:var(--ok);font-weight:700">${money2(lead.invoiced_amount * (lead.commission_rate ?? 0.05))}</div></div>` : ''}
        ${lead.message ? `<div class="item wide"><div class="k">Mensaje del cliente</div><div class="v" style="font-weight:400">${esc(lead.message)}</div></div>` : ''}
        ${lead.notes ? `<div class="item wide"><div class="k">Notas</div><div class="v" style="font-weight:400">${esc(lead.notes)}</div></div>` : ''}
        ${lead.lost_reason ? `<div class="item wide"><div class="k">Motivo de pérdida</div><div class="v" style="font-weight:400">${esc(lead.lost_reason)}</div></div>` : ''}
      </div>

      <div class="section-title">Añadir nota</div>
      <div class="field">
        <textarea id="noteInput" placeholder="Ej.: No contesta, volver a llamar por la tarde."></textarea>
        <div style="display:flex;justify-content:flex-end;margin-top:8px">
          <button class="btn btn-sm" onclick="addNote(${lead.id})">Guardar nota</button>
        </div>
      </div>

      ${canEditContact ? `
      <div class="section-title">Editar datos</div>
      <div class="form-grid">
        <div class="field"><label>Nombre</label><input id="e_name" value="${esc(lead.name || '')}"></div>
        <div class="field"><label>Teléfono</label><input id="e_phone" value="${esc(lead.phone || '')}"></div>
        <div class="field"><label>Email</label><input id="e_email" value="${esc(lead.email || '')}"></div>
        <div class="field"><label>Localidad</label><input id="e_locality" value="${esc(lead.locality || '')}"></div>
        <div class="field"><label>Producto</label><select id="e_product">
          <option value="">—</option>
          ${Object.entries(PRODUCTS).map(([k, v]) => `<option value="${k}" ${lead.product === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
        <div class="field"><label>Prioridad</label><select id="e_priority">
          <option value="0" ${!lead.priority ? 'selected' : ''}>Normal</option>
          <option value="1" ${lead.priority ? 'selected' : ''}>Prioritario</option>
        </select></div>
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:12px">
        <button class="btn btn-primary btn-sm" onclick="saveContact(${lead.id})">Guardar datos</button>
      </div>` : ''}

      <div class="section-title">Historial</div>
      <div class="timeline">
        ${events.map(e => `
          <div class="tl-item">
            <div class="tl-dot ${e.type === 'login' ? 'gray' : ''}"></div>
            <div class="tl-body">
              <div class="tl-top">
                <span class="tl-type">${eventLabel(e.type)}</span>
                <span class="tl-when">${fDateTime(e.at)}${e.user_name ? ' · ' + esc(e.user_name) : ''}</span>
              </div>
              ${e.detail ? `<div class="tl-detail">${esc(e.detail)}</div>` : ''}
            </div>
          </div>`).join('')}
      </div>
    </div>
  `;
}

function eventLabel(t) {
  return { creado: 'Lead creado', estado: 'Cambio de estado', edicion: 'Edición', nota: 'Nota',
           webhook: 'Entrada web', login: 'Acceso', usuario: 'Usuarios', password: 'Contraseña' }[t] || t;
}

function actionButtons(lead) {
  const r = state.user.role;
  const b = [];
  const add = (status, label, cls = '') =>
    b.push(`<button class="btn btn-sm ${cls}" onclick="advance(${lead.id},'${status}')">${label}</button>`);

  if (r === 'central' || r === 'admin') {
    if (lead.status === 'nuevo') add('contactado', 'Contactado', 'btn-primary');
    if (['nuevo', 'contactado'].includes(lead.status)) add('cita', 'Concertar cita', 'btn-primary');
    if (!['ganado', 'perdido'].includes(lead.status)) add('descartado', 'Descartar', 'btn-danger');
  }
  if (r === 'comercial' || r === 'admin') {
    if (['cita', 'contactado'].includes(lead.status)) add('visitado', 'Visita realizada', 'btn-primary');
    if (['visitado', 'cita'].includes(lead.status)) add('presupuestado', 'Presupuestado');
    if (['visitado', 'presupuestado', 'cita'].includes(lead.status)) add('ganado', 'Vendido', 'btn-primary');
    if (!['ganado'].includes(lead.status)) add('perdido', 'Perdido', 'btn-danger');
  }
  if (r === 'admin' && lead.status !== 'nuevo') add('nuevo', 'Reabrir');

  return b.length ? b.join('') : '<span style="font-size:13px;color:var(--ink-3)">Sin acciones disponibles para tu rol en este estado.</span>';
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#overlay').hidden = true;
  $('#drawer').innerHTML = '';
  state.drawerLead = null;
}

$('#overlay').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

/* --- acciones con formulario contextual --- */

function advance(id, status) {
  const lead = state.drawerLead;
  const panel = $('#actionPanel');
  const back = `<button class="btn btn-sm" onclick="$('#actionPanel').innerHTML=''">Cancelar</button>`;

  if (status === 'cita') {
    panel.innerHTML = `
      <div class="card" style="margin:0 0 14px;border-color:#cfe0df">
        <h3 style="margin-bottom:12px">Concertar cita</h3>
        <div class="form-grid">
          <div class="field"><label>Fecha y hora</label><input type="datetime-local" id="f_appt" value="${toLocalInput(new Date(Date.now() + 864e5).toISOString())}"></div>
          <div class="field"><label>Comercial</label><select id="f_comm">
            <option value="">— sin asignar —</option>
            ${(state.meta.commercials || []).map(c => `<option value="${c.id}" ${lead.commercial_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select></div>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary btn-sm" onclick="submitAdvance(${id},'cita')">Confirmar cita</button>
          ${back}
        </div>
      </div>`;
    return;
  }

  if (status === 'ganado') {
    panel.innerHTML = `
      <div class="card" style="margin:0 0 14px;border-color:#bfe6cb">
        <h3 style="margin-bottom:12px">Marcar venta</h3>
        <div class="form-grid">
          <div class="field"><label>Importe facturado (€)</label><input type="number" step="0.01" min="0" id="f_inv" placeholder="0,00"></div>
          <div class="field"><label>Referencia factura</label><input id="f_ref" placeholder="Opcional"></div>
          <div class="field"><label>Importe presupuestado (€)</label><input type="number" step="0.01" min="0" id="f_quo" value="${lead.quoted_amount ?? ''}"></div>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary btn-sm" onclick="submitAdvance(${id},'ganado')">Confirmar venta</button>
          ${back}
        </div>
      </div>`;
    return;
  }

  if (status === 'perdido') {
    panel.innerHTML = `
      <div class="card" style="margin:0 0 14px;border-color:#f3c6c6">
        <h3 style="margin-bottom:12px">Marcar como perdido</h3>
        <div class="field"><label>Motivo</label><select id="f_lost">
          <option>Precio</option><option>No contesta</option><option>Ya tiene proveedor</option>
          <option>No le interesa</option><option>Zona no cubierta</option><option>Otro</option>
        </select></div>
        <div class="form-actions">
          <button class="btn btn-danger btn-sm" onclick="submitAdvance(${id},'perdido')">Confirmar</button>
          ${back}
        </div>
      </div>`;
    return;
  }

  if (status === 'presupuestado') {
    panel.innerHTML = `
      <div class="card" style="margin:0 0 14px">
        <h3 style="margin-bottom:12px">Presupuesto entregado</h3>
        <div class="field"><label>Importe presupuestado (€)</label><input type="number" step="0.01" min="0" id="f_quo2" value="${lead.quoted_amount ?? ''}"></div>
        <div class="form-actions">
          <button class="btn btn-primary btn-sm" onclick="submitAdvance(${id},'presupuestado')">Guardar</button>
          ${back}
        </div>
      </div>`;
    return;
  }

  submitAdvance(id, status);
}

async function submitAdvance(id, status) {
  const body = { status };
  if (status === 'cita') {
    const v = $('#f_appt')?.value;
    if (!v) return toast('Indica fecha y hora', 'err');
    body.appointment_at = new Date(v).toISOString();
    const c = $('#f_comm')?.value;
    if (c) body.commercial_id = Number(c);
  }
  if (status === 'ganado') {
    const inv = $('#f_inv')?.value;
    if (inv === '' || inv == null) return toast('Indica el importe facturado', 'err');
    body.invoiced_amount = Number(inv);
    const ref = $('#f_ref')?.value;
    if (ref) body.invoice_ref = ref;
    const q = $('#f_quo')?.value;
    if (q) body.quoted_amount = Number(q);
  }
  if (status === 'perdido') body.lost_reason = $('#f_lost')?.value || 'Sin especificar';
  if (status === 'presupuestado') {
    const q = $('#f_quo2')?.value;
    if (q) body.quoted_amount = Number(q);
  }

  try {
    const { lead } = await api('/api/leads/' + id, { method: 'PATCH', body });
    toast('Actualizado: ' + STATUS[lead.status], 'ok');
    await openLead(id);
    if (state.view === 'leads' || state.view === 'panel' || state.view === 'comisiones' || state.view === 'kanban') render();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function addNote(id) {
  const text = $('#noteInput').value.trim();
  if (!text) return;
  try {
    await api(`/api/leads/${id}/note`, { method: 'POST', body: { text } });
    toast('Nota guardada', 'ok');
    await openLead(id);
  } catch (e) { toast(e.message, 'err'); }
}

async function saveContact(id) {
  const body = {
    name: $('#e_name').value.trim(),
    phone: $('#e_phone').value.trim(),
    email: $('#e_email').value.trim(),
    locality: $('#e_locality').value.trim(),
    product: $('#e_product').value || null,
    priority: Number($('#e_priority').value),
  };
  try {
    await api('/api/leads/' + id, { method: 'PATCH', body });
    toast('Datos guardados', 'ok');
    await openLead(id);
    if (state.view === 'leads') render();
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------------- nuevo lead ---------------- */

function renderNuevo(main) {
  main.innerHTML = `
    <div class="page-head"><div><h2>Nuevo lead</h2><p>Para entradas por teléfono, feria o referidos</p></div></div>
    <div class="card" style="max-width:820px">
      <form id="newForm">
        <div class="form-grid">
          <div class="field"><label>Nombre</label><input name="name" required></div>
          <div class="field"><label>Teléfono</label><input name="phone" inputmode="tel"></div>
          <div class="field"><label>Email</label><input name="email" type="email"></div>
          <div class="field"><label>Localidad</label><input name="locality"></div>
          <div class="field"><label>Código postal</label><input name="postal_code" inputmode="numeric"></div>
          <div class="field"><label>Origen</label><select name="source">
            ${Object.entries(SOURCES).map(([k, v]) => `<option value="${k}" ${k === 'telefono' ? 'selected' : ''}>${v}</option>`).join('')}
          </select></div>
          <div class="field"><label>Tipo de cliente</label><select name="client_type">
            <option value="particular">Particular</option><option value="empresa">Empresa</option>
          </select></div>
          <div class="field"><label>Producto de interés</label><select name="product">
            <option value="">—</option>
            ${Object.entries(PRODUCTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
          </select></div>
          <div class="field"><label>Comercial</label><select name="commercial_id">
            <option value="">— sin asignar —</option>
            ${(state.meta.commercials || []).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
          </select></div>
          <div class="field"><label>Prioridad</label><select name="priority">
            <option value="0">Normal</option><option value="1">Prioritario</option>
          </select></div>
          <div class="field full"><label>Mensaje / qué pide</label><textarea name="message" placeholder="Ej.: Quiere ósmosis para casa, tiene el agua muy dura."></textarea></div>
          <div class="field full"><label>Notas internas</label><textarea name="notes"></textarea></div>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">Crear lead</button>
          <button class="btn" type="button" onclick="setView('leads')">Cancelar</button>
        </div>
      </form>
    </div>`;

  $('#newForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = Object.fromEntries(f.entries());
    if (body.priority) body.priority = Number(body.priority);
    if (body.commercial_id) body.commercial_id = Number(body.commercial_id);
    else delete body.commercial_id;

    try {
      const { lead } = await api('/api/leads', { method: 'POST', body });
      toast('Lead ' + lead.ref + ' creado', 'ok');
      state.view = 'leads';
      render();
      setTimeout(() => openLead(lead.id), 250);
    } catch (err) { toast(err.message, 'err'); }
  });
}

/* ---------------- comisiones ---------------- */

async function renderComisiones(main) {
  main.innerHTML = `<div class="page-head"><div><h2>Comisiones</h2><p>Cargando…</p></div></div>`;

  const [{ leads }, s] = await Promise.all([
    api('/api/leads?status=ganado&limit=500'),
    api('/api/stats?month=' + state.month),
  ]);

  const won = leads;
  const total = won.reduce((a, l) => a + (l.invoiced_amount || 0), 0);
  const comm = won.reduce((a, l) => a + (l.invoiced_amount || 0) * (l.commission_rate ?? 0.05), 0);

  main.innerHTML = `
    <div class="page-head">
      <div><h2>Comisiones</h2><p>Ventas cerradas y tu 5%</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-sm" onclick="exportCsv()">Exportar CSV</button>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi"><div class="label">Ventas</div><div class="value">${won.length}</div><div class="sub">cerradas con factura</div></div>
      <div class="kpi"><div class="label">Facturado</div><div class="value">${money(total)}</div><div class="sub">ticket medio ${money(won.length ? total / won.length : 0)}</div></div>
      <div class="kpi accent"><div class="label">Comisión acumulada</div><div class="value">${money2(comm)}</div><div class="sub">5% sobre facturación</div></div>
    </div>

    <div class="card">
      <h3>Detalle de ventas</h3>
      ${won.length ? `
      <div class="table-wrap">
        <table class="data">
          <thead><tr>
            <th>Ref</th><th>Cliente</th><th>Producto</th><th>Factura</th>
            <th class="num">Importe</th><th class="num">Comisión</th>
          </tr></thead>
          <tbody>
            ${won.map(l => `<tr onclick="openLead(${l.id})" style="cursor:pointer">
              <td><span class="lead-ref">${esc(l.ref)}</span></td>
              <td><b>${esc(l.name || '—')}</b><br><small style="color:var(--ink-3)">${esc(l.locality || '')}</small></td>
              <td>${esc(PRODUCTS[l.product] || '—')}</td>
              <td>${l.invoice_ref ? esc(l.invoice_ref) : '<span style="color:var(--ink-3)">—</span>'}<br><small style="color:var(--ink-3)">${fDate(l.invoiced_at)}</small></td>
              <td class="num"><b>${money2(l.invoiced_amount)}</b></td>
              <td class="num" style="color:var(--ok);font-weight:700">${money2((l.invoiced_amount || 0) * (l.commission_rate ?? 0.05))}</td>
            </tr>`).join('')}
          </tbody>
          <tfoot><tr>
            <td colspan="4">Total</td>
            <td class="num">${money2(total)}</td>
            <td class="num" style="color:var(--ok)">${money2(comm)}</td>
          </tr></tfoot>
        </table>
      </div>` : `<p style="color:var(--ink-3);font-size:13.5px;margin:0">Todavía no hay ventas cerradas. Cuando el comercial marque un lead como <b>Vendido</b> e introduzca el importe, aparecerá aquí.</p>`}
    </div>

    <div class="card">
      <h3>Cómo se calcula</h3>
      <p style="font-size:13.5px;color:var(--ink-2);margin:0">
        Comisión = <b>importe facturado × 5%</b>. Solo cuentan los leads registrados en este CRM.
        Cada lead guarda fecha y hora de entrada inmutables, así que la atribución queda documentada desde el primer contacto.
        Para conciliar con el cliente, exporta el CSV del mes y cruza las referencias de factura.
      </p>
    </div>`;

  $$('#main table.data tbody tr').forEach(tr => tr.addEventListener('click', () => {
    const ref = tr.querySelector('.lead-ref').textContent;
    const l = won.find(x => x.ref === ref);
    if (l) openLead(l.id);
  }));
}

function exportCsv() {
  window.location.href = '/api/export.csv?month=' + state.month;
}

/* ---------------- usuarios ---------------- */

async function renderUsuarios(main) {
  const { users } = await api('/api/users');

  main.innerHTML = `
    <div class="page-head"><div><h2>Usuarios</h2><p>Quién puede entrar y qué puede hacer</p></div></div>

    <div class="card">
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            ${users.map(u => `<tr>
              <td><b>${esc(u.name)}</b></td>
              <td>${esc(u.username)}</td>
              <td>${ROLE[u.role] || u.role}</td>
              <td>${u.active ? '<span class="badge ganado">activo</span>' : '<span class="badge descartado">inactivo</span>'}</td>
              <td style="text-align:right">
                <button class="btn btn-sm" onclick="resetPass(${u.id},'${esc(u.name)}')">Cambiar contraseña</button>
                ${u.id !== state.user.id ? `<button class="btn btn-sm" onclick="toggleUser(${u.id},${u.active ? 0 : 1})">${u.active ? 'Desactivar' : 'Activar'}</button>` : ''}
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" style="max-width:760px">
      <h3>Crear usuario</h3>
      <form id="userForm">
        <div class="form-grid">
          <div class="field"><label>Nombre</label><input name="name" required></div>
          <div class="field"><label>Usuario</label><input name="username" required autocapitalize="none"></div>
          <div class="field"><label>Contraseña</label><input name="password" type="text" required minlength="8" placeholder="mínimo 8 caracteres"></div>
          <div class="field"><label>Rol</label><select name="role">
            <option value="central">Central de llamadas</option>
            <option value="comercial">Comercial</option>
            <option value="admin">Administrador</option>
          </select></div>
          <div class="field"><label>Teléfono</label><input name="phone"></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Crear usuario</button></div>
      </form>
    </div>

    <div class="card">
      <h3>Qué ve cada rol</h3>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Rol</th><th>Puede hacer</th><th>No puede</th></tr></thead>
          <tbody>
            <tr><td><b>Administrador</b> (tú)</td><td>Todo, importes, comisiones, usuarios, exportar</td><td>—</td></tr>
            <tr><td><b>Central</b></td><td>Ver todos los leads, crear, llamar, concertar cita, notas</td><td>Ver importes ni comisiones</td></tr>
            <tr><td><b>Comercial</b></td><td>Ver sus citas, marcar visita, presupuesto, venta o pérdida</td><td>Ver leads no asignados</td></tr>
          </tbody>
        </table>
      </div>
      <p style="font-size:12.5px;color:var(--ink-3);margin:12px 0 0">
        Ningún rol puede borrar leads: si hace falta quitar uno, se marca como <b>Descartado</b> y queda el rastro.
      </p>
    </div>`;

  $('#userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      await api('/api/users', { method: 'POST', body });
      toast('Usuario creado', 'ok');
      render();
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function resetPass(id, name) {
  const p = prompt(`Nueva contraseña para ${name} (mínimo 8 caracteres):`);
  if (!p) return;
  try {
    await api('/api/users/' + id, { method: 'PATCH', body: { password: p } });
    toast('Contraseña actualizada', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function toggleUser(id, active) {
  try {
    await api('/api/users/' + id, { method: 'PATCH', body: { active: !!active } });
    render();
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------------- mi cuenta ---------------- */

function renderCuenta(main) {
  const u = state.user;
  main.innerHTML = `
    <div class="page-head"><div><h2>Mi cuenta</h2><p>${esc(u.name)} · ${ROLE[u.role] || u.role}</p></div></div>
    <div class="card" style="max-width:520px">
      <h3>Cambiar contraseña</h3>
      <form id="passForm">
        <div class="field"><label>Contraseña actual</label><input name="current" type="password" required></div>
        <div class="field" style="margin-top:12px"><label>Nueva contraseña</label><input name="next" type="password" required minlength="8"><div class="hint">Mínimo 8 caracteres.</div></div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Cambiar</button></div>
      </form>
    </div>`;

  $('#passForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      await api('/api/me/password', { method: 'POST', body });
      toast('Contraseña cambiada', 'ok');
      e.target.reset();
    } catch (err) { toast(err.message, 'err'); }
  });
}

/* ---------------- arranque ---------------- */

window.addEventListener('hashchange', () => {
  const v = location.hash.replace('#', '');
  if (v && v !== state.view && ['panel', 'leads', 'kanban', 'nuevo', 'comisiones', 'usuarios', 'cuenta'].includes(v)) {
    state.view = v;
    render();
  }
});

window.setView = setView;
window.openLead = openLead;
window.closeDrawer = closeDrawer;
window.advance = advance;
window.submitAdvance = submitAdvance;
window.addNote = addNote;
window.saveContact = saveContact;
window.exportCsv = exportCsv;
window.resetPass = resetPass;
window.toggleUser = toggleUser;
window.moveLead = moveLead;

boot();
