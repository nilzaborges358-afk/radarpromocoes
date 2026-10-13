const $ = (id) => document.getElementById(id);
const MIN_INTERVAL = 2; // minutos — abaixo disso vira spam

let destinations = [];
let groups = [];
let running = false;
let inFlight = false;
let nextAt = 0;
let sentThisRun = 0;
let errorsInRow = 0;
let tickTimer = null;
let wakeLock = null;

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

async function api(body) {
  const res = await fetch('/api/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Falha na requisição');
    err.code = data.code;
    err.retryAfter = data.retryAfter;
    throw err;
  }
  return data;
}

function log(text, kind) {
  const line = document.createElement('div');
  if (kind) line.className = kind;
  line.textContent = `${new Date().toLocaleTimeString('pt-BR')}  ${text}`;
  const box = $('log');
  box.prepend(line);
  while (box.children.length > 60) box.removeChild(box.lastChild);
}

// ---------- carregar dados ----------

async function loadAll() {
  try {
    const [d, g] = await Promise.all([
      fetch('/api/dispatch').then((r) => r.json()),
      fetch('/api/groups').then((r) => r.json()),
    ]);
    if (d.error) throw new Error(d.error);
    destinations = d.destinations || [];
    groups = g.groups || [];
    renderDestinations();
    renderGroups();
    restoreSettings();
    updateModeUI();
  } catch (err) {
    $('destMsg').textContent = `Erro ao carregar: ${err.message} (já rodou o SQL v30 no Supabase?)`;
  }
}

function renderDestinations() {
  const list = $('destList');
  if (!destinations.length) {
    list.innerHTML = '<div class="dest-row"><span class="dest-meta">Nenhum destino ainda. Adicione um abaixo.</span></div>';
  } else {
    list.innerHTML = destinations.map((d) => `
      <div class="dest-row">
        <div>
          <div class="dest-name">${escapeHtml(d.name)}</div>
          <div class="dest-meta">${d.platform === 'telegram' ? `Telegram · ${escapeHtml(d.chat_id)}` : 'WhatsApp (assistido)'} · enviados em 24h: ${d.sentLast24h}/${d.daily_limit}</div>
        </div>
        <div class="dest-actions">
          <button class="btn secondary small" data-test="${d.id}">Testar</button>
          <button class="btn danger small" data-del="${d.id}">Remover</button>
        </div>
      </div>`).join('');
    list.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => testDestination(b.dataset.test)));
    list.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => removeDestination(b.dataset.del)));
  }

  const sel = $('destSelect');
  const prev = sel.value;
  sel.innerHTML = destinations.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
  if (destinations.some((d) => d.id === prev)) sel.value = prev;
}

function renderGroups() {
  const options = [...groups.map((g) => ({ id: g.id, name: g.name })), { id: 'none', name: 'Sem grupo' }];
  $('groupBox').innerHTML = options.map((g) => `
    <label class="check"><input type="checkbox" class="grp" value="${g.id}" checked /> ${escapeHtml(g.name)}</label>`).join('');
}

// ---------- configurações lembradas no navegador (nada sensível) ----------

function saveSettings() {
  localStorage.setItem('dispatcher', JSON.stringify({
    dest: $('destSelect').value, mp: $('mpSelect').value, interval: $('interval').value,
    maxSends: $('maxSends').value, footer: $('footer').value,
  }));
}

function restoreSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('dispatcher') || '{}');
    if (s.dest && destinations.some((d) => d.id === s.dest)) $('destSelect').value = s.dest;
    if (s.mp !== undefined) $('mpSelect').value = s.mp;
    if (s.interval) $('interval').value = s.interval;
    if (s.maxSends) $('maxSends').value = s.maxSends;
    if (s.footer !== undefined) $('footer').value = s.footer;
  } catch { /* ignora */ }
}

function selectedDest() {
  return destinations.find((d) => d.id === $('destSelect').value) || null;
}

function updateModeUI() {
  const dest = selectedDest();
  const manual = dest && dest.platform === 'whatsapp_manual';
  $('startBtn').classList.toggle('hidden', running || manual);
  $('stopBtn').classList.toggle('hidden', !running);
  $('waBtn').classList.toggle('hidden', !manual);
  $('runWarn').classList.toggle('hidden', manual);
  ['destSelect', 'mpSelect', 'interval', 'maxSends', 'footer', 'testBtn', 'queueBtn'].forEach((id) => { $(id).disabled = running; });
  document.querySelectorAll('.grp').forEach((c) => { c.disabled = running; });
}

function filters() {
  const group_ids = [...document.querySelectorAll('.grp:checked')].map((c) => c.value);
  return { group_ids, marketplace: $('mpSelect').value || null, footer: $('footer').value.trim() };
}

// ---------- destinos ----------

async function addDestination() {
  const btn = $('addDestBtn');
  btn.disabled = true;
  $('destMsg').textContent = '';
  try {
    const data = await api({
      action: 'create_destination',
      platform: $('newPlatform').value,
      name: $('newName').value,
      chat_id: $('newChat').value,
      bot_token: $('newToken').value,
      daily_limit: $('newLimit').value,
    });
    ['newName', 'newChat', 'newToken'].forEach((id) => { $(id).value = ''; });
    $('destMsg').textContent = data.botUsername ? `Destino criado. Bot reconhecido: @${data.botUsername}. Clique em "Testar".` : 'Destino criado.';
    await loadAll();
  } catch (err) {
    $('destMsg').textContent = `Erro: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function removeDestination(id) {
  if (!confirm('Remover esse destino? O histórico de envios dele também some.')) return;
  await api({ action: 'delete_destination', id });
  await loadAll();
}

// Abre o WhatsApp numa aba aberta no clique (senão o navegador bloqueia o pop-up).
function openWhatsAppTab() {
  return window.open('', '_blank');
}
function fillWhatsAppTab(tab, message) {
  const url = `https://wa.me/?text=${encodeURIComponent(message)}`;
  if (tab) tab.location = url; else window.open(url, '_blank');
}

async function testDestination(id) {
  const dest = destinations.find((d) => d.id === id);
  const tab = dest && dest.platform === 'whatsapp_manual' ? openWhatsAppTab() : null;
  try {
    const r = await api({ action: 'test', destination_id: id });
    if (r.manual) fillWhatsAppTab(tab, r.message);
    log(`Teste enviado para "${dest ? dest.name : ''}".`, 'ok');
    $('destMsg').textContent = 'Teste enviado — confira no destino.';
  } catch (err) {
    if (tab) tab.close();
    log(`Teste falhou: ${err.message}`, 'err');
    $('destMsg').textContent = `Erro: ${err.message}`;
  }
}

// ---------- fila ----------

async function refreshQueue() {
  const dest = selectedDest();
  if (!dest) { $('queueInfo').textContent = 'Crie um destino primeiro.'; return; }
  $('queueInfo').textContent = 'Consultando a fila...';
  try {
    const f = filters();
    const r = await api({ action: 'queue', destination_id: dest.id, group_ids: f.group_ids, marketplace: f.marketplace });
    if (!r.count) {
      $('queueInfo').textContent = 'Fila vazia: nenhuma promoção com link de afiliado, vista nos últimos 3 dias, que ainda não tenha ido para esse destino. Rode uma busca no Painel geral.';
    } else {
      const n = r.next;
      $('queueInfo').textContent = `Na fila: ${r.count}. Próxima: ${n.title.slice(0, 70)} — R$ ${Number(n.price).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}${n.discount ? ` (${Math.round(n.discount)}% OFF)` : ''}${n.marketplace ? ` · ${n.marketplace}` : ''}`;
    }
  } catch (err) {
    $('queueInfo').textContent = `Erro: ${err.message}`;
  }
}

// ---------- disparo automático (Telegram) ----------

async function acquireWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* sem suporte: segue */ }
}
function releaseWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch { /* ignora */ }
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (running && document.visibilityState === 'visible') acquireWakeLock();
});
window.addEventListener('beforeunload', (e) => {
  if (running) { e.preventDefault(); e.returnValue = ''; }
});

async function startRun() {
  const dest = selectedDest();
  if (!dest) { alert('Crie e selecione um destino.'); return; }
  const interval = parseInt($('interval').value, 10);
  const maxSends = parseInt($('maxSends').value, 10) || 20;
  const f = filters();

  if (!interval || interval < MIN_INTERVAL) { alert(`O intervalo mínimo é ${MIN_INTERVAL} minutos.`); return; }
  if (!f.group_ids.length) { alert('Marque pelo menos um grupo.'); return; }
  if (!confirm(`Enviar 1 promoção a cada ${interval} min para "${dest.name}", até ${maxSends} envios.\n\nA aba precisa ficar aberta e o computador ligado. Começar?`)) return;

  saveSettings();
  running = true;
  sentThisRun = 0;
  errorsInRow = 0;
  nextAt = Date.now(); // o primeiro envio sai agora
  await acquireWakeLock();
  tickTimer = setInterval(tick, 1000);
  updateModeUI();
  log(`Disparo iniciado: ${interval} min de intervalo, até ${maxSends} envios.`, 'ok');
}

function stopRun(reason) {
  if (!running) return;
  running = false;
  clearInterval(tickTimer);
  tickTimer = null;
  releaseWakeLock();
  updateModeUI();
  $('statusBox').classList.remove('running');
  $('statusBox').innerHTML = `<b>Parado.</b> ${escapeHtml(reason || '')}`;
  log(`Disparo parado. ${reason || ''}`);
  loadAll();
}

function tick() {
  if (!running) return;
  const remaining = nextAt - Date.now();
  const box = $('statusBox');
  box.classList.add('running');
  if (inFlight) {
    box.innerHTML = '<span class="big">Enviando...</span>';
  } else if (remaining > 0) {
    const m = String(Math.floor(remaining / 60000)).padStart(2, '0');
    const s = String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0');
    box.innerHTML = `<span class="big">Próximo envio em ${m}:${s}</span><br>Enviados nesta sessão: ${sentThisRun}`;
  }
  if (remaining <= 0 && !inFlight) doSend();
}

async function doSend() {
  inFlight = true;
  const dest = selectedDest();
  const f = filters();
  const interval = parseInt($('interval').value, 10);
  const maxSends = parseInt($('maxSends').value, 10) || 20;

  try {
    const r = await api({ action: 'send_next', destination_id: dest.id, group_ids: f.group_ids, marketplace: f.marketplace, footer: f.footer });
    if (r.empty) {
      stopRun('A fila acabou: não há mais promoções com link de afiliado para esse filtro.');
      return;
    }
    sentThisRun += 1;
    errorsInRow = 0;
    log(`✅ ${r.sent.title.slice(0, 70)}${r.sent.marketplace ? ` (${r.sent.marketplace})` : ''} — restam ${r.remaining} na fila`, 'ok');
    if (sentThisRun >= maxSends) { stopRun(`Meta de ${maxSends} envios atingida.`); return; }
    nextAt = Date.now() + interval * 60000;
  } catch (err) {
    errorsInRow += 1;
    log(`⚠️ ${err.message}`, 'err');
    if (err.code === 'daily_limit') { stopRun('Limite diário do destino atingido.'); return; }
    if (err.code === 'rate_limited') nextAt = Date.now() + ((err.retryAfter || 60) + 1) * 1000;
    else if (err.code === 'too_fast') nextAt = Date.now() + 60000;
    else if (errorsInRow >= 3) { stopRun('3 falhas seguidas — parei por segurança.'); return; }
    else nextAt = Date.now() + 60000;
  } finally {
    inFlight = false;
  }
}

// ---------- WhatsApp assistido ----------

async function openNextWhatsApp() {
  const dest = selectedDest();
  if (!dest) return;
  const f = filters();
  const tab = openWhatsAppTab();
  try {
    const r = await api({ action: 'send_next', destination_id: dest.id, group_ids: f.group_ids, marketplace: f.marketplace, footer: f.footer });
    if (r.empty) {
      if (tab) tab.close();
      $('statusBox').textContent = 'Fila vazia para esse filtro.';
      return;
    }
    fillWhatsAppTab(tab, r.message);
    $('statusBox').innerHTML = `<b>Preparado:</b> ${escapeHtml(r.promotion.title.slice(0, 80))}<br>Restam ${r.remaining} na fila. Escolha o grupo no WhatsApp e toque em enviar.`;
    log(`📱 Preparado para WhatsApp: ${r.promotion.title.slice(0, 70)}`, 'ok');
    loadAll();
  } catch (err) {
    if (tab) tab.close();
    $('statusBox').textContent = `Erro: ${err.message}`;
    log(`⚠️ ${err.message}`, 'err');
  }
}

// ---------- eventos ----------

$('newPlatform').addEventListener('change', () => {
  document.querySelectorAll('.tg-only').forEach((el) => el.classList.toggle('hidden', $('newPlatform').value !== 'telegram'));
});
$('addDestBtn').addEventListener('click', addDestination);
$('destSelect').addEventListener('change', () => { updateModeUI(); saveSettings(); $('queueInfo').textContent = ''; });
$('queueBtn').addEventListener('click', refreshQueue);
$('testBtn').addEventListener('click', () => { const d = selectedDest(); if (d) testDestination(d.id); });
$('startBtn').addEventListener('click', startRun);
$('stopBtn').addEventListener('click', () => stopRun('Parado por você.'));
$('waBtn').addEventListener('click', openNextWhatsApp);

loadAll();
