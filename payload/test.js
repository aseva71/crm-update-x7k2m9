'use strict';
/**
 * Pruebas de extremo a extremo del CRM (sin frameworks).
 * Uso: node test.js
 */
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8090';

let pass = 0, fail = 0;
const fails = [];

function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

async function req(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, data, setCookie, headers: res.headers, text };
}

function cookieOf(setCookie) {
  return setCookie ? setCookie.split(';')[0] : '';
}

(async () => {
  const ADMIN = { u: process.env.CRM_ADMIN_USER || 'alfredo', p: process.env.CRM_ADMIN_PASS };
  const CENTRAL = { u: process.env.CRM_CENTRAL_USER || 'central', p: process.env.CRM_CENTRAL_PASS };
  const COMERCIAL = { u: process.env.CRM_COMERCIAL_USER || 'comercial', p: process.env.CRM_COMERCIAL_PASS };

  console.log('\n1) Estáticos y salud');
  const home = await req('/');
  ok(home.status === 200 && /Activemur/.test(home.text), 'GET / sirve la aplicación');
  const css = await req('/styles.css');
  ok(css.status === 200, 'GET /styles.css');
  const js = await req('/app.js');
  ok(js.status === 200, 'GET /app.js');
  const trav = await req('/../db.js');
  ok(trav.status === 404 || trav.status === 403, 'path traversal bloqueado');

  console.log('\n2) Autenticación');
  const badLogin = await req('/api/login', { method: 'POST', body: { username: ADMIN.u, password: 'malo' } });
  ok(badLogin.status === 401, 'login con contraseña incorrecta → 401');
  const noAuth = await req('/api/leads');
  ok(noAuth.status === 401, 'API sin sesión → 401');

  const login = await req('/api/login', { method: 'POST', body: { username: ADMIN.u, password: ADMIN.p } });
  ok(login.status === 200 && login.data.user.role === 'admin', 'login admin correcto');
  const adminCookie = cookieOf(login.setCookie);
  ok(/HttpOnly/i.test(login.setCookie || ''), 'cookie HttpOnly');
  ok(/SameSite=Lax/i.test(login.setCookie || ''), 'cookie SameSite=Lax');

  const me = await req('/api/me', { cookie: adminCookie });
  ok(me.status === 200 && me.data.user.username === ADMIN.u, 'GET /api/me con sesión');

  console.log('\n3) Webhook de la web (WordPress)');
  const TOKEN = process.env.CRM_WEBHOOK_TOKEN;
  const whBad = await req('/api/webhook/lead', { method: 'POST', body: { name: 'X', phone: '600000001' } });
  ok(whBad.status === 401, 'webhook sin token → 401');

  const RND = Date.now().toString().slice(-6);
  const whBody = {
    name: 'Test Webhook', phone: '699' + RND, email: `test.${RND}@example.com`,
    locality: 'Murcia', product: 'osmosis', source: 'web_form',
    utm_source: 'google', utm_campaign: 'osmosis-murcia',
    message: 'Prueba automatizada',
  };
  const wh = await req('/api/webhook/lead?token=' + TOKEN, { method: 'POST', body: whBody });
  ok(wh.status === 201 && wh.data.ref, 'webhook crea lead y devuelve referencia', JSON.stringify(wh.data));
  const whRef = wh.data.ref;

  const whDup = await req('/api/webhook/lead?token=' + TOKEN, { method: 'POST', body: whBody });
  ok(whDup.data.duplicate === true && whDup.data.ref === whRef, 'webhook deduplica el mismo lead');

  const whNoContact = await req('/api/webhook/lead?token=' + TOKEN, { method: 'POST', body: { name: 'Sin datos' } });
  ok(whNoContact.status === 400, 'webhook sin teléfono/email → 400');

  console.log('\n4) Lectura de leads');
  const list = await req('/api/leads?status=todos', { cookie: adminCookie });
  ok(list.status === 200 && list.data.leads.length > 0, 'lista de leads');
  const whLead = list.data.leads.find(l => l.ref === whRef);
  ok(!!whLead, 'el lead del webhook aparece en la lista');
  ok(whLead && whLead.utm_campaign === 'osmosis-murcia', 'se guarda la campaña UTM');
  ok(whLead && Math.abs(Date.parse(whLead.created_at) - Date.now()) < 300000, 'created_at es la hora real de entrada');

  const search = await req('/api/leads?status=todos&q=699' + RND, { cookie: adminCookie });
  ok(search.data.leads.some(l => l.ref === whRef), 'búsqueda por teléfono');

  console.log('\n5) Permisos: central');
  const lc = await req('/api/login', { method: 'POST', body: { username: CENTRAL.u, password: CENTRAL.p } });
  ok(lc.status === 200 && lc.data.user.role === 'central', 'login central');
  const centralCookie = cookieOf(lc.setCookie);

  const centralList = await req('/api/leads?status=todos', { cookie: centralCookie });
  ok(centralList.status === 200, 'central puede listar');
  const cl0 = centralList.data.leads[0];
  ok(cl0 && cl0.quoted_amount === undefined && cl0.invoiced_amount === undefined,
     'central NO ve importes');

  const centralWin = await req('/api/leads/' + whLead.id, { method: 'PATCH', cookie: centralCookie, body: { status: 'ganado', invoiced_amount: 3000 } });
  ok(centralWin.status === 403, 'central no puede marcar vendido → 403');

  const centralContact = await req('/api/leads/' + whLead.id, { method: 'PATCH', cookie: centralCookie, body: { status: 'contactado', notes: 'Llamado, pide presupuesto' } });
  ok(centralContact.status === 200, 'central sí puede marcar contactado');

  const centralStats = await req('/api/stats', { cookie: centralCookie });
  ok(centralStats.data.commission === undefined && centralStats.data.invoiced === undefined, 'central no ve comisiones en el panel');

  console.log('\n6) Permisos: comercial');
  const lm = await req('/api/login', { method: 'POST', body: { username: COMERCIAL.u, password: COMERCIAL.p } });
  ok(lm.status === 200 && lm.data.user.role === 'comercial', 'login comercial');
  const comCookie = cookieOf(lm.setCookie);

  const comList = await req('/api/leads?status=todos', { cookie: comCookie });
  ok(comList.status === 200, 'comercial lista');
  const notMine = comList.data.leads.find(l => l.commercial_id === null || l.commercial_id === undefined);
  ok(!notMine, 'comercial solo ve leads asignados a él');

  const meta = await req('/api/meta', { cookie: adminCookie });
  const comId = (meta.data.commercials.find(c => c.role === 'comercial') || {}).id;

  // admin asigna el lead al comercial y concierta cita
  const appt = new Date(Date.now() + 864e5).toISOString();
  const assign = await req('/api/leads/' + whLead.id, {
    method: 'PATCH', cookie: adminCookie,
    body: { status: 'cita', appointment_at: appt, commercial_id: comId },
  });
  ok(assign.status === 200 && assign.data.lead.status === 'cita', 'admin concierta cita');

  const comList2 = await req('/api/leads?status=todos', { cookie: comCookie });
  ok(comList2.data.leads.some(l => l.id === whLead.id), 'el comercial ve su cita');

  const comWrongStatus = await req('/api/leads/' + whLead.id, { method: 'PATCH', cookie: comCookie, body: { status: 'descartado' } });
  ok(comWrongStatus.status === 403, 'comercial no puede descartar → 403');

  const comWin = await req('/api/leads/' + whLead.id, {
    method: 'PATCH', cookie: comCookie,
    body: { status: 'ganado', invoiced_amount: 2450, invoice_ref: 'FAC-TEST-001' },
  });
  ok(comWin.status === 200 && comWin.data.lead.status === 'ganado', 'comercial marca venta');
  ok(comWin.data.lead.invoiced_at, 'al vender se fija fecha de facturación');

  console.log('\n7) Comisiones y estadísticas');
  const stats = await req('/api/stats?month=' + new Date().toISOString().slice(0, 7), { cookie: adminCookie });
  ok(stats.status === 200, 'GET /api/stats');
  ok(stats.data.invoiced > 0, 'facturado del mes > 0', String(stats.data.invoiced));
  const expected = stats.data.invoiced * 0.05;
  ok(Math.abs(stats.data.commission - expected) < 0.01, 'comisión = 5% exacto del facturado',
     `esperado ${expected.toFixed(2)}, obtenido ${stats.data.commission.toFixed(2)}`);

  console.log('\n8) Historial inmutable');
  const detail = await req('/api/leads/' + whLead.id, { cookie: adminCookie });
  ok(detail.data.events.length >= 3, 'el lead tiene historial de eventos', String(detail.data.events.length));
  ok(detail.data.events.some(e => e.type === 'webhook'), 'evento de entrada web registrado');
  ok(detail.data.events.some(e => e.type === 'estado'), 'cambios de estado registrados');

  console.log('\n9) Exportación CSV');
  const csv = await req('/api/export.csv?month=' + new Date().toISOString().slice(0, 7), { cookie: adminCookie });
  ok(csv.status === 200 && /ref;created_at/.test(csv.text), 'CSV con cabecera');
  const csvBytes = await (await fetch(BASE + '/api/export.csv', { headers: { Cookie: adminCookie } })).arrayBuffer();
  const first3 = new Uint8Array(csvBytes.slice(0, 3));
  ok(first3[0] === 0xEF && first3[1] === 0xBB && first3[2] === 0xBF, 'CSV con BOM UTF-8 (Excel)',
     Array.from(first3).map(b => b.toString(16)).join(' '));
  ok(csv.text.includes(whRef), 'el lead exportado está en el CSV');
  const csvCentral = await req('/api/export.csv', { cookie: centralCookie });
  ok(csvCentral.status === 403, 'central no puede exportar → 403');

  console.log('\n10) Alta de usuarios y contraseñas');
  const newUsername = 'test_com_' + Date.now().toString().slice(-6);
  const newUser = await req('/api/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: newUsername, password: 'prueba12345', name: 'Comercial Test', role: 'comercial' },
  });
  ok(newUser.status === 201, 'admin crea usuario');
  const dupUser = await req('/api/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: newUsername, password: 'prueba12345', name: 'Dup', role: 'comercial' },
  });
  ok(dupUser.status === 409, 'usuario duplicado → 409');
  const shortPass = await req('/api/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'corto', password: '123', name: 'X', role: 'central' },
  });
  ok(shortPass.status === 400, 'contraseña corta rechazada');

  const badRole = await req('/api/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'rolmalo', password: 'prueba12345', name: 'X', role: 'superroot' },
  });
  ok(badRole.status === 400, 'rol inválido rechazado');

  const changePass = await req('/api/me/password', {
    method: 'POST', cookie: adminCookie,
    body: { current: ADMIN.p, next: 'nuevaClave2026' },
  });
  ok(changePass.status === 200, 'cambio de contraseña propio');
  const relogin = await req('/api/login', { method: 'POST', body: { username: ADMIN.u, password: 'nuevaClave2026' } });
  ok(relogin.status === 200, 'login con la nueva contraseña');
  // restaurar
  const restore = await req('/api/me/password', {
    method: 'POST', cookie: cookieOf(relogin.setCookie),
    body: { current: 'nuevaClave2026', next: ADMIN.p },
  });
  ok(restore.status === 200, 'contraseña restaurada');

  console.log('\n11) Cierre de sesión');
  const logout = await req('/api/logout', { method: 'POST', cookie: adminCookie });
  ok(logout.status === 200, 'logout');
  const afterLogout = await req('/api/me', { cookie: adminCookie });
  ok(afterLogout.status === 401, 'la sesión deja de valer tras logout');

  console.log('\n12) No hay borrado de leads');
  const relog = await req('/api/login', { method: 'POST', body: { username: ADMIN.u, password: ADMIN.p } });
  const delCookie = cookieOf(relog.setCookie);
  const del = await req('/api/leads/' + whLead.id, { method: 'DELETE', cookie: delCookie });
  ok(del.status === 404 || del.status === 405, 'borrado de leads no existe', 'HTTP ' + del.status);

  console.log('\n13) Transiciones del embudo en el servidor');
  const fresh = await req('/api/leads', {
    method: 'POST', cookie: delCookie,
    body: { name: 'Test transiciones', phone: '688' + RND, source: 'telefono' },
  });
  ok(fresh.status === 201, 'lead nuevo creado para probar transiciones');
  const fid = fresh.data.lead.id;
  const meta2 = await req('/api/meta', { cookie: delCookie });
  const cid2 = meta2.data.commercials.find(c => c.role === 'comercial').id;
  await req('/api/leads/' + fid, { method: 'PATCH', cookie: delCookie, body: { commercial_id: cid2 } });

  const skip = await req('/api/leads/' + fid, {
    method: 'PATCH', cookie: comCookie,
    body: { status: 'ganado', invoiced_amount: 999 },
  });
  ok(skip.status === 400, 'salto nuevo → ganado bloqueado por el servidor', 'HTTP ' + skip.status);

  const okStep = await req('/api/leads/' + fid, { method: 'PATCH', cookie: comCookie, body: { status: 'visitado' } });
  ok(okStep.status === 400, 'el comercial tampoco puede saltar a visitado desde nuevo', 'HTTP ' + okStep.status);

  const forceAdmin = await req('/api/leads/' + fid, { method: 'PATCH', cookie: delCookie, body: { status: 'ganado', invoiced_amount: 500 } });
  ok(forceAdmin.status === 200, 'el administrador sí puede forzar el estado');

  console.log('\n14) Tracking público, atribución y economía');
  const ORIGIN = 'https://aseva71.github.io';
  const XIP = { 'X-Forwarded-For': '198.51.100.' + (RND % 250) };
  const pre = await req('/api/track', { method: 'OPTIONS', headers: { Origin: ORIGIN } });
  ok(pre.status === 204 && pre.headers.get('access-control-allow-origin') === ORIGIN, 'preflight CORS permitido');

  const badOrigin = await req('/api/public/lead', {
    method: 'POST', headers: { Origin: 'https://evil.example', ...XIP },
    body: { phone: '600000000', rgpd: true },
  });
  ok(badOrigin.status === 403, 'origen no autorizado rechazado', 'HTTP ' + badOrigin.status);

  const VID = 'vid-test-' + RND;
  const trk = await req('/api/track', {
    method: 'POST', headers: { Origin: ORIGIN },
    body: { vid: VID, event: 'page_view', path: '/', gclid: 'Cj0KTEST', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'osmosis-murcia' },
  });
  ok(trk.status === 202, 'evento page_view aceptado', 'HTTP ' + trk.status);

  const noVid = await req('/api/track', { method: 'POST', headers: { Origin: ORIGIN }, body: { event: 'page_view' } });
  ok(noVid.status === 400, 'evento sin vid rechazado');

  const consentless = await req('/api/public/lead', {
    method: 'POST', headers: { Origin: ORIGIN, ...XIP }, body: { name: 'Sin consentimiento', phone: '600' + RND },
  });
  ok(consentless.status === 400, 'lead sin consentimiento rechazado');

  const honeypot = await req('/api/public/lead', {
    method: 'POST', headers: { Origin: ORIGIN, ...XIP },
    body: { website: 'spam', phone: '600' + RND, rgpd: true },
  });
  ok(honeypot.status === 200 && honeypot.data.ignored, 'honeypot ignorado en silencio');

  const pub = await req('/api/public/lead', {
    method: 'POST', headers: { Origin: ORIGIN, ...XIP },
    body: {
      vid: VID, name: 'Lead público test', phone: '655' + RND, locality: 'Murcia',
      solucion: 'osmosis', rgpd: true, gclid: 'Cj0KTEST', utm_source: 'google',
      utm_medium: 'cpc', utm_campaign: 'osmosis-murcia', landing_page: '/', self_reported: 'Google',
    },
  });
  ok(pub.status === 201 && /^ACT-/.test(pub.data.ref || ''), 'lead público creado con referencia');

  const pubDup = await req('/api/public/lead', {
    method: 'POST', headers: { Origin: ORIGIN, ...XIP },
    body: { name: 'Lead público test', phone: '655' + RND, rgpd: true },
  });
  ok(pubDup.status === 200 && pubDup.data.duplicate, 'duplicado en 24 h detectado');

  const sp = await req('/api/spend', {
    method: 'POST', cookie: delCookie,
    body: { channel: 'google-ads', campaign: 'osmosis-murcia', amount: 123.45, note: 'test' },
  });
  ok(sp.status === 200, 'gasto declarado');

  const tr = await req('/api/traffic', { cookie: delCookie });
  const ch = (tr.data.channels || []).find(c => c.channel === 'google-ads');
  ok(tr.status === 200 && ch && ch.leads >= 1, 'el panel atribuye el lead a google-ads');
  ok(tr.data.economy && tr.data.economy.spend >= 123.45, 'la economía suma el gasto');

  const centralSpend = await req('/api/spend', { method: 'POST', cookie: cookieOf((await req('/api/login', { method: 'POST', body: { username: CENTRAL.u, password: CENTRAL.p } })).setCookie), body: { channel: 'otro', amount: 1 } });
  ok(centralSpend.status === 403, 'la central no puede declarar gasto');

  const spendRow = tr.data.spend.find(s => s.channel === 'google-ads');
  const delSpendRes = await req('/api/spend/' + spendRow.id, { method: 'DELETE', cookie: delCookie });
  ok(delSpendRes.status === 200, 'gasto eliminado');

  console.log(`\n=== ${pass} OK, ${fail} fallos ===`);
  if (fail) { console.log('Fallos:\n - ' + fails.join('\n - ')); process.exit(1); }
})().catch(e => { console.error('ERROR FATAL:', e.message); process.exit(1); });
