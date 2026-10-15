const $ = (id) => document.getElementById(id);
const MIN_INTERVAL = 2; // minutos — abaixo disso vira spam

let destinations = [];
let groups = [];
let jobs = [];
let serverOffset = 0; // diferenca entre o relogio do servidor e o do computador
let pollTimer = null;
let uiTimer = null;
let ticking = false;
let lastTickErr = '';
let lastSeen = {};
let alarmKey = null;
let audioCtx = null;
let waAlarmTimer = null;
let waTitleTimer = null;
const WA_MIN_INTERVAL = 1; // minutos (WhatsApp assistido: quem envia e voce)

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

// ---------- erros visíveis ----------
// Se algo quebrar, a mensagem aparece na tela (em vez de campos em branco sem explicação).
function showPageError(msg) {
  const el = $('destMsg');
  if (el) el.textContent = `Erro na página: ${msg}. Atualize com Ctrl+F5; se continuar, me mande esta mensagem.`;
}
window.addEventListener('error', (e) => showPageError(e.message));
window.addEventListener('unhandledrejection', (e) => showPageError((e.reason && e.reason.message) || String(e.reason)));

// ---------- carregar dados ----------

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `Erro ${res.status}`);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('o servidor demorou mais de 15s para responder');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Destinos e grupos carregam de forma independente: se um falhar, o outro continua aparecendo.
async function loadAll() {
  // Nunca deixa os campos em branco enquanto carrega.
  if (!$('destSelect').options.length) $('destSelect').innerHTML = '<option value="">Carregando destinos...</option>';
  if (!$('groupBox').children.length) $('groupBox').innerHTML = '<span class="dest-meta">Carregando grupos...</span>';
  const [d, g] = await Promise.allSettled([fetchJson('/api/dispatch'), fetchJson('/api/groups')]);

  if (d.status === 'fulfilled') {
    destinations = d.value.destinations || [];
    jobs = d.value.jobs || [];
    if (d.value.now) serverOffset = new Date(d.value.now).getTime() - Date.now();
    $('destMsg').textContent = '';
  } else {
    destinations = [];
    $('destMsg').textContent = `Erro ao carregar destinos: ${d.reason.message} (já rodou o SQL 0002_disparador.sql no Supabase? Está logado?)`;
  }

  if (g.status === 'fulfilled') groups = g.value.groups || [];
  else { groups = []; $('queueInfo').textContent = `Erro ao carregar grupos: ${g.reason.message}`; }

  renderDestinations(d.status === 'rejected' ? d.reason.message : null);
  renderGroups();
  restoreSettings();
  applyJobToUI();
  updateModeUI();
  jobs.forEach((j) => { lastSeen[j.id] = jobSig(j); });
  renderJob();
  ensurePolling();
}

function renderDestinations(loadError) {
  // O seletor da etapa 2 é montado primeiro, independente da lista da etapa 1.
  const sel = $('destSelect');
  const prev = sel.value;
  if (destinations.length) {
    sel.innerHTML = destinations.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}${d.platform === 'whatsapp_manual' ? ' (WhatsApp)' : ' (Telegram)'}</option>`).join('');
    if (destinations.some((d) => d.id === prev)) sel.value = prev;
  } else {
    sel.innerHTML = `<option value="">${loadError ? 'Erro ao carregar destinos' : 'Nenhum destino — adicione na etapa 1'}</option>`;
  }

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

}

// Nomes iguais viram UM grupo só. O valor da caixinha guarda todos os ids do grupo (separados por vírgula).
function mergedGroups() {
  const map = new Map();
  groups.forEach((g) => {
    const key = String(g.name || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!map.has(key)) map.set(key, { name: String(g.name || '').replace(/\s+/g, ' ').trim(), ids: [] });
    map.get(key).ids.push(g.id);
    const cleaned = String(g.name || '').replace(/\s+/g, ' ').trim();
    if (!/[A-ZÀ-Þ]/.test(map.get(key).name) && /[A-ZÀ-Þ]/.test(cleaned)) map.get(key).name = cleaned;
  });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

function renderGroups() {
  const options = [...mergedGroups().map((g) => ({ id: g.ids.join(','), name: g.name })), { id: 'none', name: 'Sem grupo' }];
  $('groupBox').innerHTML = options.map((g) => `
    <label class="check"><input type="checkbox" class="grp" value="${escapeHtml(g.id)}" checked /> ${escapeHtml(g.name)}</label>`).join('');
}

// ---------- configurações lembradas no navegador (nada sensível) ----------

function saveSettings() {
  localStorage.setItem('dispatcher', JSON.stringify({
    dest: $('destSelect').value, mp: $('mpSelect').value, interval: $('interval').value,
    maxSends: $('maxSends').value, footer: $('footer').value, groups: filters().group_ids,
  }));
}

function checkGroups(ids) {
  const set = new Set(ids || []);
  document.querySelectorAll('.grp').forEach((c) => { c.checked = c.value.split(',').some((id) => set.has(id)); });
}

function restoreSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('dispatcher') || '{}');
    if (s.dest && destinations.some((d) => d.id === s.dest)) $('destSelect').value = s.dest;
    if (s.mp !== undefined) $('mpSelect').value = s.mp;
    if (s.interval) $('interval').value = s.interval;
    if (s.maxSends) $('maxSends').value = s.maxSends;
    if (s.footer !== undefined && !/afiliad/i.test(s.footer)) $('footer').value = s.footer;
    if (Array.isArray(s.groups) && s.groups.length) checkGroups(s.groups);
  } catch { /* ignora */ }
}

// Se ja existe um disparo rodando (ou parado) para o destino escolhido, mostra os filtros DELE.
function applyJobToUI() {
  const job = selectedJob(false);
  if (!job) return;
  const f = job.filters || {};
  $('interval').value = job.interval_min;
  $('maxSends').value = job.max_sends;
  $('mpSelect').value = f.marketplace || '';
  $('footer').value = f.footer || '';
  checkGroups(f.group_ids || []);
}

function selectedDest() {
  return destinations.find((d) => d.id === $('destSelect').value) || null;
}

function updateModeUI() {
  const dest = selectedDest();
  const manual = !!dest && dest.platform === 'whatsapp_manual';
  const busy = !!selectedJob(false);
  $('startBtn').classList.toggle('hidden', busy || manual);
  $('stopBtn').classList.toggle('hidden', !busy || manual);
  $('waStartBtn').classList.toggle('hidden', !manual || busy);
  $('waStopBtn').classList.toggle('hidden', !manual || !busy);
  $('waBtn').classList.toggle('hidden', !manual || busy);
  ['destSelect', 'mpSelect', 'interval', 'maxSends', 'footer', 'testBtn', 'queueBtn', 'verifyBtn'].forEach((id) => { $(id).disabled = busy && id !== 'destSelect' ? true : false; });
  document.querySelectorAll('.grp').forEach((c) => { c.disabled = busy; });
}

function filters() {
  const group_ids = [...document.querySelectorAll('.grp:checked')].flatMap((c) => c.value.split(',')).filter(Boolean);
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
      $('queueInfo').textContent = `Na fila: ${r.count}. Próxima: ${n.title.slice(0, 70)} — R$ ${Number(n.price).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${n.discount ? ` (${Math.round(n.discount)}% OFF)` : ''}${n.marketplace ? ` · ${n.marketplace}` : ''}`;
    }
  } catch (err) {
    $('queueInfo').textContent = `Erro: ${err.message}`;
  }
}

// ---------- disparo contínuo (o estado fica salvo no servidor) ----------
// Recarregar a página, trocar de aba ou publicar uma atualização NÃO zera nada:
// contador, horário do próximo envio e total enviado ficam no banco.

function selectedJob(includeStopped) {
  const d = selectedDest();
  if (!d) return null;
  const list = jobs.filter((j) => j.destination_id === d.id);
  const running = list.find((j) => j.status === 'running');
  return running || (includeStopped ? list[0] || null : null);
}

const serverNow = () => Date.now() + serverOffset;
const jobSig = (j) => `${j.sent_count}|${j.status}|${j.last_event || ''}|${j.last_error || ''}`;

function applyJobs(data) {
  if (data.now) serverOffset = new Date(data.now).getTime() - Date.now();
  jobs = data.jobs || [];
  jobs.forEach((j) => {
    const sig = jobSig(j);
    if (lastSeen[j.id] !== undefined && lastSeen[j.id] !== sig) {
      if (j.last_error) log(`⚠️ ${j.last_error}`, 'err');
      else if (j.last_event) log(j.last_event, 'ok');
    }
    lastSeen[j.id] = sig;
  });
  updateModeUI();
  renderJob();
  ensurePolling();
}

// Pergunta ao servidor se tem envio na hora (e o servidor executa). Roda enquanto houver disparo ativo.
async function tickServer() {
  if (ticking) return;
  ticking = true;
  try {
    applyJobs(await api({ action: 'tick' }));
    lastTickErr = '';
  } catch (err) {
    if (err.message !== lastTickErr) { lastTickErr = err.message; log(`⚠️ Sem resposta do servidor (${err.message}). Tentando de novo...`, 'err'); }
  } finally {
    ticking = false;
  }
}

function ensurePolling() {
  const any = jobs.some((j) => j.status === 'running');
  if (any && !pollTimer) { pollTimer = setInterval(tickServer, 10000); tickServer(); }
  if (!any && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (!uiTimer) uiTimer = setInterval(renderJob, 1000);
}

function renderJob() {
  const box = $('statusBox');
  const openBtn = $('waOpenBtn');
  const job = selectedJob(true);
  if (!job) { openBtn.classList.add('hidden'); return; }

  if (job.status !== 'running') {
    box.classList.remove('running', 'alert');
    box.innerHTML = `<b>Parado.</b> ${escapeHtml(job.last_event || '')}${job.last_error ? `<br>⚠️ ${escapeHtml(job.last_error)}` : ''}<br>Enviados nesta rodada: ${job.sent_count}/${job.max_sends}`;
    openBtn.classList.add('hidden');
    alarmKey = null; stopAlarm();
    return;
  }

  if (job.pending) {
    box.classList.remove('running'); box.classList.add('alert');
    box.innerHTML = `<span class="big">🔔 PRONTA PARA ENVIAR</span><br>${escapeHtml(String(job.pending.title || '').slice(0, 90))}${job.pending.coupon ? ` · cupom <b>${escapeHtml(job.pending.coupon)}</b>` : ''}<br>Restam ${job.pending.remaining} na fila. Aperte o botão (ou Enter), escolha o grupo e envie.`;
    openBtn.classList.remove('hidden');
    if (alarmKey !== job.pending.prepared_at) {
      alarmKey = job.pending.prepared_at;
      startAlarm(String(job.pending.title || ''));
      try { navigator.clipboard.writeText(job.pending.message); } catch { /* ignora */ }
    }
    return;
  }

  alarmKey = null; stopAlarm();
  openBtn.classList.add('hidden');
  box.classList.remove('alert'); box.classList.add('running');
  const remaining = new Date(job.next_run_at).getTime() - serverNow();
  const progress = `Enviados: ${job.sent_count}/${job.max_sends}`;
  if (remaining > 0) {
    const m = String(Math.floor(remaining / 60000)).padStart(2, '0');
    const s = String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0');
    box.innerHTML = `<span class="big">Próximo envio em ${m}:${s}</span><br>${progress}${job.last_event ? `<br>${escapeHtml(job.last_event)}` : ''}`;
  } else {
    box.innerHTML = `<span class="big">${job.mode === 'assisted' ? 'Preparando e conferindo o produto...' : 'Enviando...'}</span><br>${progress}`;
  }
}

async function startRun() {
  const dest = selectedDest();
  if (!dest) { alert('Crie e selecione um destino.'); return; }
  const manual = dest.platform === 'whatsapp_manual';
  const interval = parseInt($('interval').value, 10);
  const maxSends = parseInt($('maxSends').value, 10) || 20;
  const f = filters();
  const minInterval = manual ? WA_MIN_INTERVAL : MIN_INTERVAL;
  if (!interval || interval < minInterval) { alert(`O intervalo mínimo é ${minInterval} minuto(s).`); return; }
  if (!f.group_ids.length) { alert('Marque pelo menos um grupo.'); return; }
  const aviso = manual
    ? 'A cada intervalo o sistema prepara a promoção e toca o alerta; você só abre e envia.'
    : 'O disparo fica salvo no servidor: pode recarregar a página ou trocar de aba.';
  if (!confirm(`Enviar 1 promoção a cada ${interval} min para "${dest.name}", até ${maxSends} envios.\n\n${aviso}\n\nComeçar?`)) return;

  unlockAudio();
  try { if (manual && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); } catch { /* ignora */ }
  saveSettings();
  try {
    applyJobs(await api({ action: 'job_start', destination_id: dest.id, interval_min: interval, max_sends: maxSends, group_ids: f.group_ids, marketplace: f.marketplace, footer: f.footer }));
    log(`Disparo iniciado: 1 promoção a cada ${interval} min, até ${maxSends} envios.`, 'ok');
    if (manual) beep();
  } catch (err) {
    log(`⚠️ ${err.message}`, 'err');
    alert(err.message);
  }
}

async function stopRun() {
  const job = selectedJob(false);
  if (!job) return;
  try {
    applyJobs(await api({ action: 'job_stop', destination_id: job.destination_id }));
    log('Disparo parado por você.');
  } catch (err) { log(`⚠️ ${err.message}`, 'err'); }
}

// ---------- WhatsApp assistido ----------

async function openNextWhatsApp() {
  const dest = selectedDest();
  if (!dest) return;
  const f = filters();
  const tab = openWhatsAppTab();
  try {
    const r = await api({ action: 'send_next', destination_id: dest.id, group_ids: f.group_ids, marketplace: f.marketplace, footer: f.footer });
    logSkipped(r.skipped);
    if (r.empty) {
      if (tab) tab.close();
      $('statusBox').textContent = 'Fila vazia para esse filtro.';
      return;
    }
    fillWhatsAppTab(tab, r.message);
    $('statusBox').innerHTML = `<b>Preparado:</b> ${escapeHtml(r.promotion.title.slice(0, 80))}${r.promotion.coupon ? ` · cupom <b>${escapeHtml(r.promotion.coupon)}</b>` : ''}<br>Restam ${r.remaining} na fila. Escolha o grupo no WhatsApp e toque em enviar.`;
    log(`📱 Preparado para WhatsApp: ${r.promotion.title.slice(0, 70)}`, 'ok');
    loadAll();
  } catch (err) {
    if (tab) tab.close();
    $('statusBox').textContent = `Erro: ${err.message}`;
    log(`⚠️ ${err.message}`, 'err');
  }
}


function logSkipped(list) {
  (list || []).forEach((x) => log(`⏭️ Pulada: ${String(x.title).slice(0, 60)} — ${x.reason}`, 'err'));
}

// ---------- verificar fila (sem enviar) ----------

async function verifyQueueUI() {
  const dest = selectedDest();
  if (!dest) { $('queueInfo').textContent = 'Crie um destino primeiro.'; return; }
  $('queueInfo').textContent = 'Conferindo os próximos produtos (abrindo cada link)... pode levar até 1 minuto.';
  $('verifyBtn').disabled = true;
  try {
    const f = filters();
    const r = await api({ action: 'verify', destination_id: dest.id, group_ids: f.group_ids, marketplace: f.marketplace });
    let msg = `Conferidos ${r.checked} de ${r.total} na fila: ${r.ok} ok`;
    if (r.removed.length) msg += `, ${r.removed.length} removidos (produto não existe mais)`;
    if (r.warnings.length) msg += `. ⚠️ ${r.warnings[0]}`;
    $('queueInfo').textContent = msg + '.';
    r.removed.forEach((x) => log(`🗑️ Removida: ${String(x.title).slice(0, 60)} — ${x.reason}`, 'err'));
  } catch (err) {
    $('queueInfo').textContent = `Erro: ${err.message}`;
  } finally {
    $('verifyBtn').disabled = false;
  }
}

// ---------- WhatsApp com alerta (semi-automático) ----------
// O WhatsApp não permite postar em grupo por API. Aqui o sistema prepara a mensagem no tempo certo,
// toca um alarme + notificação, e você só abre, escolhe o grupo e envia (1 toque).

function beep() {
  // Som suave: dois toques graves e curtos, tipo "gota" (sem aquele bipe agudo de alerta).
  try {
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    [[392, 0], [523.25, 0.32]].forEach(([freq, delay]) => { // sol -> do
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + delay);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + delay + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 1.1);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0 + delay); o.stop(t0 + delay + 1.2);
    });
  } catch { /* sem áudio: segue */ }
}

function startAlarm(title) {
  stopAlarm();
  beep();
  waAlarmTimer = setInterval(beep, 20000); // repete a cada 20s até você abrir
  const original = document.title;
  let on = false;
  waTitleTimer = setInterval(() => { on = !on; document.title = on ? '🔔 ENVIAR AGORA!' : original; }, 800);
  waTitleTimer.original = original;
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification('📱 Promoção pronta para enviar', { body: title.slice(0, 100), requireInteraction: true });
      n.onclick = () => { window.focus(); n.close(); };
    }
  } catch { /* ignora */ }
}

function stopAlarm() {
  if (waAlarmTimer) clearInterval(waAlarmTimer);
  if (waTitleTimer) { clearInterval(waTitleTimer); document.title = waTitleTimer.original || document.title; }
  waAlarmTimer = null; waTitleTimer = null;
}

function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* sem áudio */ }
}
// O navegador só libera som depois de um clique. Qualquer clique na página já destrava.
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, unlockAudio, { passive: true }));

async function waOpenPending() {
  const job = selectedJob(false);
  if (!job || !job.pending) return;
  const msg = job.pending.message;
  window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank'); // dentro do clique, senão o navegador bloqueia
  stopAlarm(); alarmKey = null;
  $('waOpenBtn').classList.add('hidden');
  log(`📱 Aberto no WhatsApp: ${String(job.pending.title || '').slice(0, 70)}`, 'ok');
  try { applyJobs(await api({ action: 'job_ack', destination_id: job.destination_id })); }
  catch (err) { log(`⚠️ ${err.message}`, 'err'); }
}

document.addEventListener('keydown', (e) => {
  const job = selectedJob(false);
  if (job && job.pending && e.key === 'Enter' && document.activeElement && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement.tagName)) {
    e.preventDefault(); waOpenPending();
  }
});

// ---------- eventos ----------

$('newPlatform').addEventListener('change', () => {
  document.querySelectorAll('.tg-only').forEach((el) => el.classList.toggle('hidden', $('newPlatform').value !== 'telegram'));
});
$('addDestBtn').addEventListener('click', addDestination);
$('destSelect').addEventListener('change', () => { applyJobToUI(); updateModeUI(); renderJob(); saveSettings(); $('queueInfo').textContent = ''; });
$('queueBtn').addEventListener('click', refreshQueue);
$('testBtn').addEventListener('click', () => { const d = selectedDest(); if (d) testDestination(d.id); });
$('startBtn').addEventListener('click', startRun);
$('stopBtn').addEventListener('click', stopRun);
$('waBtn').addEventListener('click', openNextWhatsApp);
$('waStartBtn').addEventListener('click', startRun);
$('waStopBtn').addEventListener('click', stopRun);
$('waOpenBtn').addEventListener('click', waOpenPending);
$('verifyBtn').addEventListener('click', verifyQueueUI);

loadAll();
