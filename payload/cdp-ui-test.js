'use strict';
/**
 * Prueba de interfaz con Chromium headless vía CDP.
 * Uso: node cdp-ui-test.js
 */
const { spawn } = require('child_process');
const CHROME = process.env.CHROME_BIN || '/opt/hermes/tools/chromium-1208/chrome-linux64/chrome';
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8090';
const PORT = 9333;
const DIR = '/tmp/chrome-crm-test';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0; const fails = [];
function ok(c, name, extra) {
  if (c) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1280,900', `--remote-debugging-port=${PORT}`, `--user-data-dir=${DIR}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let list = null;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      list = await r.json();
      if (list.some(t => t.type === 'page')) break;
    } catch {}
    await sleep(250);
  }
  if (!list) { console.error('Chromium no arrancó'); chrome.kill(); process.exit(1); }

  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception?.description || d.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    }
  };
  const send = (method, params = {}) => new Promise(res => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' +
      (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');

  console.log('\n1) Carga de la aplicación');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(1500);
  const loginVisible = await evaluate(`!document.getElementById('login').hidden`);
  ok(loginVisible === true, 'se muestra el formulario de acceso');
  const hasBrand = await evaluate(`document.querySelector('.login-brand h1')?.textContent.includes('Activemur')`);
  ok(hasBrand === true, 'marca Activemur visible');

  console.log('\n2) Error de credenciales');
  await evaluate(`(() => {
    document.querySelector('#loginForm input[name=username]').value = 'alfredo';
    document.querySelector('#loginForm input[name=password]').value = 'incorrecta';
    document.querySelector('#loginForm').dispatchEvent(new Event('submit', {cancelable:true}));
  })()`);
  await sleep(900);
  const errShown = await evaluate(`!document.getElementById('loginError').hidden`);
  ok(errShown === true, 'muestra error con contraseña incorrecta');
  const errText = await evaluate(`document.getElementById('loginError').textContent`);
  ok(/incorrect/i.test(errText || ''), 'mensaje de error claro', errText);

  console.log('\n3) Acceso correcto');
  const adminUser = process.env.CRM_ADMIN_USER, adminPass = process.env.CRM_ADMIN_PASS;
  await evaluate(`(() => {
    document.querySelector('#loginForm input[name=username]').value = ${JSON.stringify(adminUser)};
    document.querySelector('#loginForm input[name=password]').value = ${JSON.stringify(adminPass)};
    document.querySelector('#loginForm').dispatchEvent(new Event('submit', {cancelable:true}));
  })()`);
  await sleep(2000);
  const appVisible = await evaluate(`!document.getElementById('app').hidden`);
  ok(appVisible === true, 'entra en la aplicación');

  const panelTitle = await evaluate(`document.querySelector('#main .page-head h2')?.textContent`);
  ok(panelTitle === 'Panel', 'se abre el panel', panelTitle);

  const kpis = await evaluate(`document.querySelectorAll('#main .kpi').length`);
  ok(kpis >= 6, 'muestra las tarjetas de resumen', String(kpis));

  const commission = await evaluate(`Array.from(document.querySelectorAll('#main .kpi')).map(k=>k.textContent).join('|')`);
  ok(/comisión/i.test(commission), 'el panel muestra la comisión');
  ok(/5\s*%|5%/.test(commission), 'la comisión indica el 5%');

  console.log('\n4) Lista de leads');
  await evaluate(`setView('leads')`);
  await sleep(1200);
  const rows = await evaluate(`document.querySelectorAll('#leadList .lead-row').length`);
  ok(rows > 0, 'se listan los leads', String(rows));
  const firstRef = await evaluate(`document.querySelector('#leadList .lead-ref')?.textContent`);
  ok(/^ACT-\d{4}-\d{4}$/.test(firstRef || ''), 'formato de referencia correcto', firstRef);

  console.log('\n5) Ficha del lead');
  const leadId = await evaluate(`(async () => (await (await fetch('/api/leads?status=todos')).json()).leads[0].id)()`);
  await evaluate(`openLead(${leadId})`);
  await sleep(1300);
  const drawerOpen = await evaluate(`!document.getElementById('drawer').hidden`);
  ok(drawerOpen === true, 'abre la ficha del lead');
  const parts = await evaluate(`({
    timeline: document.querySelectorAll('#drawer .tl-item').length,
    actions: document.querySelectorAll('#drawer .actions .btn').length,
    phone: /tel:/.test(document.getElementById('drawer').innerHTML),
    sections: document.querySelectorAll('#drawer .section-title').length
  })`);
  ok(parts.timeline > 0, 'la ficha muestra el historial', String(parts.timeline) + ' eventos');
  ok(parts.actions > 0, 'la ficha muestra acciones', String(parts.actions) + ' botones');
  ok(parts.phone === true, 'la ficha muestra el teléfono marcable');
  ok(parts.sections >= 4, 'la ficha está estructurada por secciones', String(parts.sections));

  await evaluate(`closeDrawer()`);
  await sleep(400);

  console.log('\n6) Vista de comisiones');
  await evaluate(`setView('comisiones')`);
  await sleep(1200);
  const commText = await evaluate(`document.querySelector('#main').innerText`);
  ok(/comisión acumulada/i.test(commText), 'vista de comisiones carga');
  ok(/detalle de ventas/i.test(commText), 'tabla de ventas presente');
  const commKpi = await evaluate(`document.querySelectorAll('#main .kpi.accent').length`);
  ok(commKpi === 1, 'tarjeta de comisión destacada', String(commKpi));

  console.log('\n7) Embudo kanban');
  await evaluate(`setView('kanban')`);
  await sleep(1400);
  const board = await evaluate(`({
    cols: document.querySelectorAll('#board .col').length,
    cards: document.querySelectorAll('#board .kcard').length,
    heads: Array.from(document.querySelectorAll('#board .col-head')).map(h => h.textContent.trim())
  })`);
  ok(board.cols === 7, 'siete columnas del embudo', String(board.cols));
  ok(board.cards > 0, 'hay tarjetas de leads', String(board.cards));
  ok(/Nuevo/.test(board.heads.join(' ')), 'columna Nuevo presente');

  const moveId = await evaluate(`(async () => {
    let r = await (await fetch('/api/leads?status=nuevo')).json();
    if (r.leads[0]) return r.leads[0].id;
    const c = await (await fetch('/api/leads', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ name: 'Lead Kanban Test', phone: '677' + Date.now().toString().slice(-6), source: 'telefono' })
    })).json();
    return c.lead ? c.lead.id : null;
  })()`);
  ok(moveId != null, 'existe un lead en Nuevo para mover');
  if (moveId != null) {
    await evaluate(`moveLead(${moveId}, 'contactado')`);
    await sleep(1500);
    const newStatus = await evaluate(`(async () => {
      const r = await (await fetch('/api/leads/${moveId}')).json();
      return r.lead.status;
    })()`);
    ok(newStatus === 'contactado', 'mover cambia el estado a contactado', newStatus);

    await evaluate(`moveLead(${moveId}, 'presupuestado')`);
    await sleep(900);
    const stillStatus = await evaluate(`(async () => {
      const r = await (await fetch('/api/leads/${moveId}')).json();
      return r.lead.status;
    })()`);
    ok(stillStatus === 'contactado', 'bloquea saltos de fase inválidos', stillStatus);

    await evaluate(`moveLead(${moveId}, 'nuevo')`);
    await sleep(800);
  }

  const citaId = await evaluate(`(async () => {
    const r = await (await fetch('/api/leads?status=contactado')).json();
    return r.leads[0] ? r.leads[0].id : null;
  })()`);
  if (citaId) {
    await evaluate(`moveLead(${citaId}, 'cita')`);
    await sleep(1600);
    const pideCita = await evaluate(`({
      drawer: !document.getElementById('drawer').hidden,
      form: !!document.getElementById('f_appt')
    })`);
    ok(pideCita.drawer === true && pideCita.form === true, 'mover a Cita pide fecha y comercial');
    await evaluate(`closeDrawer()`);
    await sleep(500);
  }

  console.log('\n8) Vista Tráfico');
  await evaluate(`setView('trafico')`);
  await sleep(1500);
  const trText = await evaluate(`document.querySelector('#main').innerText`);
  const trKpis = await evaluate(`document.querySelectorAll('#main .kpi').length`);
  ok(/Tráfico y economía/.test(trText || ''), 'la vista de tráfico pinta');
  ok(trKpis >= 6, 'seis KPIs de tráfico y economía', String(trKpis));
  ok(/google-ads/.test(trText || ''), 'el canal google-ads aparece con datos');
  ok(!!(await evaluate(`!!document.getElementById('spSave')`)), 'formulario de gasto disponible');
  ok(!(await evaluate(`document.getElementById('navTrafico').hidden`)), 'la pestaña es visible para el admin');

  console.log('\n9) Vista usuarios');
  await evaluate(`setView('usuarios')`);
  await sleep(1200);
  const usersText = await evaluate(`document.querySelector('#main').innerText`);
  ok(/Central de llamadas/.test(usersText), 'lista de usuarios y roles');

  console.log('\n9) Móvil (390x844)');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await evaluate(`setView('leads')`);
  await sleep(1200);
  const mobile = await evaluate(`({
    rows: document.querySelectorAll('#leadList .lead-row').length,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    menuVisible: getComputedStyle(document.getElementById('menuBtn')).display !== 'none'
  })`);
  ok(mobile.rows > 0, 'en móvil se ven los leads', String(mobile.rows));
  ok(mobile.overflow <= 2, 'sin desbordamiento horizontal', 'overflow ' + mobile.overflow + 'px');
  ok(mobile.menuVisible === true, 'menú hamburguesa visible en móvil');

  console.log('\n10) Consola del navegador');
  const realErrors = errors.filter(e => e && !/favicon|Failed to load resource.*401/i.test(e));
  ok(realErrors.length === 0, 'sin errores de JavaScript', realErrors.join(' | ').slice(0, 300));

  console.log(`\n=== ${pass} OK, ${fail} fallos ===`);
  ws.close();
  chrome.kill();
  if (fail) { console.log('Fallos:\n - ' + fails.join('\n - ')); process.exit(1); }
})().catch(e => { console.error('ERROR FATAL:', e.message); process.exit(1); });
