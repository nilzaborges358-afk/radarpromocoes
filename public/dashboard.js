const MARKETPLACE_LABELS = {
  mercadolivre: { name: 'Mercado Livre', color: '#fff159', textColor: '#1a1a1a' },
  shopee: { name: 'Shopee', color: '#ee4d2d', textColor: '#fff' },
  amazon: { name: 'Amazon', color: '#ff9900', textColor: '#1a1a1a' },
  magalu: { name: 'Magalu', color: '#0086ff', textColor: '#fff' },
  tiktokshop: { name: 'TikTok Shop', color: '#010101', textColor: '#fff' },
  netshoes: { name: 'Netshoes', color: '#f5761a', textColor: '#fff' },
  shein: { name: 'Shein', color: '#000000', textColor: '#fff' },
};

const STATUS_LABEL = { PENDING: 'aguardando afiliação', AFFILIATED: 'afiliada', IGNORED: 'ignorada' };
let endedColumnOk = true; // vira false se o SQL 0005 ainda não foi rodado (coluna ended_at inexistente)

let client = null;
let currentStatus = 'ALL';
// Filtros novos: uma busca livre + "chips" clicáveis (podem marcar vários). Sem listas em cascata.
const filters = { q: '', marketplaces: new Set(), groups: new Set(), keyword: null, keywordLabel: '' };
let currentSort = 'recent';
let currentDateFilter = 'TODAY';
let allPromotions = [];
let knownGroups = [];
let knownMarketplaces = [];
let promotionsCapped = false;
let loadSeq = 0;
let groupVersion = 0;     // sobe quando a lista de grupos muda (para refazer o cache do grupo de cada promoção)
const PROMO_PAGE = 1000;   // o Supabase devolve no máximo 1000 linhas por consulta
const PROMO_MAX = 3000;    // teto de linhas carregadas de uma vez (antes eram só 300 — o resto sumia do painel)

function showFatalError(message) {
  const box = document.getElementById('fatalError');
  box.style.display = 'block';
  box.innerHTML = `<strong>O painel não conseguiu iniciar.</strong><br>${message}`;
}

function init() {
  if (typeof supabase === 'undefined') {
    showFatalError('A biblioteca do Supabase não carregou (verifique sua internet e recarregue a página).');
    return;
  }

  if (
    !window.RADAR_CONFIG ||
    !window.RADAR_CONFIG.SUPABASE_URL ||
    !window.RADAR_CONFIG.SUPABASE_ANON_KEY ||
    window.RADAR_CONFIG.SUPABASE_URL.includes('SEU-PROJETO')
  ) {
    showFatalError('O arquivo <code>public/config.js</code> ainda não está preenchido com a URL e a chave reais do Supabase.');
    return;
  }

  try {
    client = supabase.createClient(window.RADAR_CONFIG.SUPABASE_URL, window.RADAR_CONFIG.SUPABASE_ANON_KEY);
  } catch (err) {
    showFatalError(`Erro ao conectar no Supabase: ${err.message}`);
    return;
  }

  document.querySelectorAll('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentStatus = btn.dataset.status;
      render();
    });
  });

  // Busca livre (produto, grupo ou palavra-chave) — com pequena espera para não recalcular a cada tecla.
  let searchTimer = null;
  const searchInput = document.getElementById('searchInput');
  searchInput.addEventListener('input', () => {
    document.getElementById('searchBox').classList.toggle('has-text', !!searchInput.value);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { filters.q = searchInput.value; render(); }, 150);
  });
  document.getElementById('searchClear').addEventListener('click', () => {
    searchInput.value = '';
    document.getElementById('searchBox').classList.remove('has-text');
    filters.q = '';
    render();
    searchInput.focus();
  });
  document.getElementById('sortFilter').addEventListener('change', (e) => { currentSort = e.target.value; render(); });
  document.getElementById('dateFilter').addEventListener('change', (e) => {
    currentDateFilter = e.target.value;
    document.getElementById('customDateRange').classList.toggle('show', currentDateFilter === 'CUSTOM');
    loadPromotions(); // o período define quantas linhas buscar no banco
  });
  document.getElementById('dateFrom').addEventListener('change', loadPromotions);
  document.getElementById('dateTo').addEventListener('change', render);
  document.getElementById('filterBar').addEventListener('click', onFilterBarClick);
  document.getElementById('clearFilters').addEventListener('click', clearAllFilters);
  document.getElementById('emptyClear').addEventListener('click', clearAllFilters);

  document.getElementById('scanBtn').addEventListener('click', openScanModal);
  document.getElementById('dedupeBtn').addEventListener('click', cleanDuplicates);
  document.getElementById('scanModalCancel').addEventListener('click', closeScanModal);
  document.getElementById('scanModalConfirm').addEventListener('click', confirmScan);
  const scanBox = document.getElementById('scanGroupsCheckboxes');
  scanBox.addEventListener('change', onScanGroupsChange);
  scanBox.addEventListener('click', onScanGroupsClick);
  document.getElementById('scanSelectAll').addEventListener('click', () => setAllScanGroups(true));
  document.getElementById('scanSelectNone').addEventListener('click', () => setAllScanGroups(false));
  document.getElementById('scanModalBack').addEventListener('click', () => { showScanStep('marketplace'); renderMarketplacePicks(); });

  loadFilterOptions();
  loadPromotions();
  setInterval(loadPromotions, 60000); // só relê o que já está salvo — não dispara nova busca
  setInterval(loadFilterOptions, 60000); // pega grupos/marketplaces novos sem precisar recarregar a página
}

async function loadFilterOptions() {
  const { data: marketplaces, error: mpError } = await client.from('marketplaces').select('slug, name').order('name');
  if (mpError) { showFatalError(`Erro ao carregar marketplaces: ${mpError.message}`); return; }
  knownMarketplaces = marketplaces || [];

  // "marketplaces" diz em quais marketplaces o grupo roda. Se a coluna ainda não existir (SQL 0008 não rodado), lê sem ela.
  let { data: groups, error: groupError } = await client.from('watch_groups').select('id, name, search_keyword, marketplaces').order('name');
  if (groupError) {
    ({ data: groups, error: groupError } = await client.from('watch_groups').select('id, name, search_keyword').order('name'));
  }
  if (groupError) { showFatalError(`Erro ao carregar grupos: ${groupError.message}`); return; }

  knownGroups = groups || [];
  groupVersion += 1;
  render();
}

function normKey(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Sem acento, minúsculo e sem espaço sobrando — para a busca achar "calca" em "Calça".
function fold(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function displayKeyword(g) {
  return (g.search_keyword || g.name || '').trim();
}

// Tudo que tem o MESMO nome (ignorando maiúsculas e espaços extras) é UM grupo só.
// Devolve [{ key, name, ids: [todos os ids do banco com esse nome], keywords: [...] }].
function mergeGroupsByName(rows) {
  const map = new Map();
  (rows || []).forEach((g) => {
    const key = normKey(g.name);
    if (!map.has(key)) map.set(key, { key, name: String(g.name || '').replace(/\s+/g, ' ').trim(), ids: [], keywords: [] });
    const merged = map.get(key);
    merged.ids.push(g.id);
    const cleaned = String(g.name || '').replace(/\s+/g, ' ').trim();
    if (!/[A-ZÀ-Þ]/.test(merged.name) && /[A-ZÀ-Þ]/.test(cleaned)) merged.name = cleaned;
    String(g.search_keyword || g.name || '').split(',').map((k) => k.trim()).filter(Boolean).forEach((kw) => {
      if (!merged.keywords.some((k) => normKey(k) === normKey(kw))) merged.keywords.push(kw);
    });
  });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

// Chave do grupo de uma promoção (grupos com o mesmo nome contam como um só).
function promoGroupKey(p) {
  if (p._gk !== undefined && p._gkv === groupVersion) return p._gk;
  const g = knownGroups.find((x) => x.id === p.watch_group_id);
  const name = g ? g.name : p.watch_groups?.name;
  p._gk = name ? normKey(name) : '__none';
  p._gkv = groupVersion;
  return p._gk;
}

// ---------- Carregamento das promoções ----------
// Antes: .limit(300) das mais recentes de TODOS os dias, e os filtros rodavam só nessas 300 — o resto "sumia".
// Agora: busca por período no banco (em páginas de 1000) e os filtros rodam em tudo que foi carregado.
function promotionsSinceISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (currentDateFilter === 'TODAY' || currentDateFilter === 'TODAY_SEEN') { d.setDate(d.getDate() - 1); return d.toISOString(); }
  if (currentDateFilter === 'YESTERDAY') { d.setDate(d.getDate() - 2); return d.toISOString(); }
  if (currentDateFilter === 'CUSTOM') {
    const from = document.getElementById('dateFrom').value;
    if (!from) return null;
    const f = new Date(`${from}T00:00:00`);
    f.setDate(f.getDate() - 1);
    return f.toISOString();
  }
  return null; // "Todos os dias"
}

async function loadPromotions() {
  const seq = ++loadSeq;
  const since = promotionsSinceISO();
  let rows = [];
  let capped = false;

  for (let from = 0; from < PROMO_MAX; from += PROMO_PAGE) {
    let query = client
      .from('promotions')
      .select('*, marketplaces(slug, name, logo_url), watch_groups(name, search_keyword)')
      .order('detected_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + PROMO_PAGE - 1);
    if (since) query = query.or(`detected_at.gte.${since},last_seen_at.gte.${since}${endedColumnOk ? `,ended_at.gte.${since}` : ''}`);

    const { data, error } = await query;
    if (error && endedColumnOk && /ended_at/i.test(error.message || '')) {
      endedColumnOk = false; // banco sem o SQL 0005: carrega do jeito antigo
      return loadPromotions();
    }
    if (error) {
      showFatalError(`Erro ao carregar as promoções: ${error.message}`);
      return;
    }
    rows = rows.concat(data || []);
    if (!data || data.length < PROMO_PAGE) break;
    if (from + PROMO_PAGE >= PROMO_MAX) capped = true;
  }

  if (seq !== loadSeq) return; // chegou uma carga mais nova enquanto esta rodava
  allPromotions = rows;
  promotionsCapped = capped;
  updateLastScanLabel();
  render();
}

function updateLastScanLabel() {
  const el = document.getElementById('lastScan');
  if (!allPromotions.length) { el.textContent = ''; return; }
  const latest = allPromotions.reduce((max, p) => (p.detected_at > max ? p.detected_at : max), allPromotions[0].detected_at);
  const formatted = new Date(latest).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `Última busca com resultado: <strong>${formatted}</strong>`;
}

// ---------- Filtros: busca livre + chips ----------
function applySearch(list) {
  const tokens = fold(filters.q).split(' ').filter(Boolean);
  const kw = filters.keyword;
  if (!tokens.length && !kw) return list;
  return list.filter((p) => {
    if (kw && normKey(p.matched_keyword || '') !== kw) return false;
    if (!tokens.length) return true;
    if (p._hay === undefined) p._hay = fold(`${p.title} ${p.matched_keyword || ''} ${p.watch_groups?.name || ''} ${p.marketplaces?.name || ''}`);
    return tokens.every((t) => p._hay.includes(t));
  });
}

function sortList(list) {
  const arr = [...list];
  const num = (v) => Number(v) || 0;
  if (currentSort === 'discount') arr.sort((a, b) => num(b.discount_rate) - num(a.discount_rate));
  else if (currentSort === 'price_asc') arr.sort((a, b) => num(a.current_price) - num(b.current_price));
  else if (currentSort === 'price_desc') arr.sort((a, b) => num(b.current_price) - num(a.current_price));
  else arr.sort((a, b) => String(b.detected_at).localeCompare(String(a.detected_at)));
  return arr;
}

function hasActiveFilters() {
  return !!(filters.q.trim() || filters.marketplaces.size || filters.groups.size || filters.keyword);
}

function clearAllFilters() {
  filters.q = '';
  filters.marketplaces.clear();
  filters.groups.clear();
  filters.keyword = null;
  filters.keywordLabel = '';
  currentSort = 'recent';
  const dateChanged = currentDateFilter !== 'TODAY';
  currentDateFilter = 'TODAY';
  document.getElementById('searchInput').value = '';
  document.getElementById('searchBox').classList.remove('has-text');
  document.getElementById('sortFilter').value = 'recent';
  document.getElementById('dateFilter').value = 'TODAY';
  document.getElementById('customDateRange').classList.remove('show');
  if (dateChanged) loadPromotions(); else render();
}

function toggleInSet(set, value) {
  if (set.has(value)) set.delete(value); else set.add(value);
}

function onFilterBarClick(e) {
  const el = e.target.closest('[data-chip]');
  if (!el) return;
  const type = el.dataset.chip;
  const value = el.dataset.value;
  if (type === 'mp-all') filters.marketplaces.clear();
  else if (type === 'mp') toggleInSet(filters.marketplaces, value);
  else if (type === 'group-all') filters.groups.clear();
  else if (type === 'group') toggleInSet(filters.groups, value);
  else if (type === 'kw-remove') { filters.keyword = null; filters.keywordLabel = ''; }
  render();
}

function chipHtml({ type, value = '', label, count, on, color }) {
  const dot = color ? `<span class="dot" style="background:${color}; ${color === '#000000' ? 'box-shadow:0 0 0 1px var(--line-strong);' : ''}"></span>` : '';
  const cnt = count === undefined ? '' : `<b>${count}</b>`;
  return `<button type="button" class="chip ${on ? 'on' : ''} ${count === 0 && !on ? 'zero' : ''}" data-chip="${type}" data-value="${escapeHtml(value).replace(/"/g, '&quot;')}" aria-pressed="${on ? 'true' : 'false'}">${dot}${escapeHtml(label)}${cnt}</button>`;
}

// Os números dos chips respeitam os OUTROS filtros (busca, palavra, período e o outro grupo de chips),
// então o que está escrito no chip é exatamente o que vai aparecer na tela ao clicar.
function renderFilterChips(collapsedAll, mpOk, grOk) {
  const mpCounts = new Map();
  collapsedAll.filter(grOk).forEach((p) => { const k = p.marketplaces?.slug || '?'; mpCounts.set(k, (mpCounts.get(k) || 0) + 1); });
  const grCounts = new Map();
  collapsedAll.filter(mpOk).forEach((p) => { const k = promoGroupKey(p); grCounts.set(k, (grCounts.get(k) || 0) + 1); });

  const mpTotal = [...mpCounts.values()].reduce((a, b) => a + b, 0);
  const mpList = [...knownMarketplaces].sort((a, b) => (mpCounts.get(b.slug) || 0) - (mpCounts.get(a.slug) || 0) || a.name.localeCompare(b.name, 'pt-BR'));
  document.getElementById('mpChips').innerHTML =
    chipHtml({ type: 'mp-all', label: 'Todos', count: mpTotal, on: filters.marketplaces.size === 0 }) +
    mpList.map((m) => chipHtml({
      type: 'mp', value: m.slug, label: MARKETPLACE_LABELS[m.slug]?.name || m.name,
      count: mpCounts.get(m.slug) || 0, on: filters.marketplaces.has(m.slug), color: MARKETPLACE_LABELS[m.slug]?.color || '#888',
    })).join('');

  const groupDefs = mergeGroupsByName(knownGroups).map((g) => ({ key: g.key, name: g.name }));
  if (grCounts.get('__none')) groupDefs.push({ key: '__none', name: 'Sem grupo' });
  const visibleGroups = groupDefs
    .filter((g) => (grCounts.get(g.key) || 0) > 0 || filters.groups.has(g.key))
    .sort((a, b) => (grCounts.get(b.key) || 0) - (grCounts.get(a.key) || 0) || a.name.localeCompare(b.name, 'pt-BR'));
  const grTotal = [...grCounts.values()].reduce((a, b) => a + b, 0);
  const groupRow = document.getElementById('groupRow');
  groupRow.style.display = visibleGroups.length ? '' : 'none';
  document.getElementById('groupChips').innerHTML = visibleGroups.length
    ? chipHtml({ type: 'group-all', label: 'Todos', count: grTotal, on: filters.groups.size === 0 }) +
      visibleGroups.map((g) => chipHtml({ type: 'group', value: g.key, label: g.name, count: grCounts.get(g.key) || 0, on: filters.groups.has(g.key) })).join('')
    : '';

  // Linha de filtros ativos (palavra-chave escolhida num cartão + limpar tudo).
  const active = document.getElementById('activeRow');
  const parts = [];
  if (filters.keyword) {
    parts.push(`<button type="button" class="chip on" data-chip="kw-remove" title="Tirar este filtro">Palavra-chave: ${escapeHtml(filters.keywordLabel || filters.keyword)} <b>✕</b></button>`);
  }
  active.style.display = parts.length ? '' : 'none';
  document.getElementById('activeChips').innerHTML = parts.join('');
  document.getElementById('clearFilters').style.display = (hasActiveFilters() || currentSort !== 'recent' || currentDateFilter !== 'TODAY') ? '' : 'none';
}

function render() {
  const grid = document.getElementById('grid');
  const empty = document.getElementById('empty');

  // 1) período + busca + palavra-chave; 2) junta anúncios repetidos; 3) chips de marketplace e de grupo.
  const isEnded = (p) => !!p.ended_at && p.status !== 'IGNORED';
  let base = applySearch(applyDateFilter(allPromotions.filter((p) => !isEnded(p))));
  // Finalizadas têm o período contado pela data em que FINALIZARAM (não pela data em que foram achadas).
  const endedBase = applySearch(applyDateFilter(allPromotions.filter(isEnded), 'ended_at'));

  // O mesmo produto vendido por vários vendedores aparece UMA vez só (a mais barata, ou a que você já afiliou),
  // com um aviso de quantos anúncios iguais existem. As ignoradas ficam só na aba "Ignoradas".
  const ignoredAll = base.filter((p) => p.status === 'IGNORED');
  const collapsedAll = collapseDuplicates(base.filter((p) => p.status !== 'IGNORED'));

  const mpOk = (p) => !filters.marketplaces.size || filters.marketplaces.has(p.marketplaces?.slug);
  const grOk = (p) => !filters.groups.size || filters.groups.has(promoGroupKey(p));
  renderFilterChips(currentStatus === 'ENDED' ? endedBase : collapsedAll, mpOk, grOk);

  const visible = collapsedAll.filter((p) => mpOk(p) && grOk(p));
  const ignored = ignoredAll.filter((p) => mpOk(p) && grOk(p));
  const endedList = endedBase.filter((p) => mpOk(p) && grOk(p));

  document.getElementById('cappedNote').style.display = promotionsCapped ? 'block' : 'none';

  // Contadores só mostram número quando há promoção de fato na tela; acompanham os filtros em tempo real.
  const hasResults = visible.length > 0;
  document.getElementById('countAll').textContent = hasResults ? visible.length : '–';
  document.getElementById('countPending').textContent = hasResults ? visible.filter((p) => p.status === 'PENDING').length : '–';
  document.getElementById('countAffiliated').textContent = hasResults ? visible.filter((p) => p.status === 'AFFILIATED').length : '–';
  document.getElementById('countEnded').textContent = endedList.length || '–';

  let list = visible;
  if (currentStatus === 'IGNORED') list = ignored;
  else if (currentStatus === 'ENDED') list = endedList;
  else if (currentStatus !== 'ALL') list = visible.filter((p) => p.status === currentStatus);
  list = sortList(list);

  if (list.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  grid.innerHTML = list.map(renderCard).join('');

  grid.querySelectorAll('.kw-pill[data-kw]').forEach((pill) => {
    pill.addEventListener('click', () => {
      filters.keyword = pill.dataset.kw;
      filters.keywordLabel = pill.dataset.kwlabel || pill.dataset.kw;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
  grid.querySelectorAll('[data-mark-affiliated]').forEach((btn) => {
    btn.addEventListener('click', () => markStatus(btn.dataset.markAffiliated, 'AFFILIATED'));
  });
  grid.querySelectorAll('[data-ignore]').forEach((btn) => {
    btn.addEventListener('click', () => markStatus(btn.dataset.ignore, 'IGNORED'));
  });
  grid.querySelectorAll('[data-share-wa]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const promo = allPromotions.find((p) => p.id === btn.dataset.shareWa);
      if (!promo) return;
      const message = buildShareMessage(promo);
      window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
    });
  });
  grid.querySelectorAll('[data-share-tg]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const promo = allPromotions.find((p) => p.id === btn.dataset.shareTg);
      if (!promo) return;
      const message = buildShareMessage(promo, { includeLink: false });
      const url = `https://t.me/share/url?url=${encodeURIComponent(promo.affiliate_url)}&text=${encodeURIComponent(message)}`;
      window.open(url, '_blank');
    });
  });
  grid.querySelectorAll('[data-copy-link]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(btn.dataset.copyLink);
      const original = btn.textContent;
      btn.textContent = 'Copiado!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    });
  });
}

function toLocalDateKey(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function applyDateFilter(list, field = 'detected_at') {
  if (currentDateFilter === 'ALL') return list;

  const today = new Date();
  const todayKey = toLocalDateKey(today);

  if (currentDateFilter === 'TODAY') {
    // Só o que foi encontrado pela PRIMEIRA vez hoje (produto reencontrado não conta como novo).
    return list.filter((p) => toLocalDateKey(p[field] || p.detected_at) === todayKey);
  }

  if (currentDateFilter === 'TODAY_SEEN') {
    // Tudo que a busca viu hoje, inclusive produtos antigos que apareceram de novo.
    return list.filter((p) => toLocalDateKey((field === 'ended_at' ? p.ended_at : p.last_seen_at) || p.detected_at) === todayKey);
  }

  if (currentDateFilter === 'YESTERDAY') {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yKey = toLocalDateKey(yesterday);
    return list.filter((p) => toLocalDateKey(p[field] || p.detected_at) === yKey);
  }

  if (currentDateFilter === 'CUSTOM') {
    const from = document.getElementById('dateFrom').value;
    const to = document.getElementById('dateTo').value;
    return list.filter((p) => {
      const key = toLocalDateKey(p[field] || p.detected_at);
      if (from && key < from) return false;
      if (to && key > to) return false;
      return true;
    });
  }

  return list;
}

function renderCard(promo) {
  const firstKey = toLocalDateKey(promo.detected_at);
  const lastKey = promo.last_seen_at ? toLocalDateKey(promo.last_seen_at) : firstKey;
  const revisto = lastKey !== firstKey
    ? ` · visto de novo em ${new Date(promo.last_seen_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}`
    : '';
  const slug = promo.marketplaces?.slug;
  const label = MARKETPLACE_LABELS[slug] || { name: promo.marketplaces?.name || 'Marketplace', color: '#444', textColor: '#fff' };
  const groupName = promo.watch_groups?.name;
  const keyword = (promo.matched_keyword || '').trim();
  const kwTip = keyword ? `${groupName ? `Grupo: ${groupName} · ` : ''}Palavra-chave que achou este produto: ${keyword}` : '';
  const detectedAt = new Date(promo.detected_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const discount = promo.discount_rate ? `-${Math.round(promo.discount_rate)}%` : '';

  return `
    <div class="card ${promo.ended_at && promo.status !== 'IGNORED' ? 'is-ended' : ''}">
      <div class="card-media">
        <div class="tag-row">
          <span class="tag" style="background:${label.color}; color:${label.textColor}">${label.name}</span>
          ${groupName ? `<span class="tag-group">${escapeHtml(groupName)}</span>` : ''}
        </div>
        <img src="${promo.image_url || ''}" alt="${escapeHtml(promo.title)}" loading="lazy" />
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(promo.title)}</div>
        ${keyword ? `<div class="kw-pill" data-kw="${escapeHtml(normKey(keyword)).replace(/"/g, '&quot;')}" data-kwlabel="${escapeHtml(keyword).replace(/"/g, '&quot;')}" title="${escapeHtml(kwTip)} — clique para filtrar só por ela"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><span>${escapeHtml(keyword)}</span></div>` : ''}
        ${promo._dupCount ? `<div class="dup-note">+${promo._dupCount} anúncio${promo._dupCount > 1 ? 's' : ''} igual${promo._dupCount > 1 ? 'is' : ''} de outro${promo._dupCount > 1 ? 's' : ''} vendedor${promo._dupCount > 1 ? 'es' : ''} (mostrando o mais barato)</div>` : ''}
        <div class="price-row">
          <span class="price-current">R$ ${formatPrice(promo.current_price)}</span>
          ${promo.previous_price ? `<span class="price-previous">R$ ${formatPrice(promo.previous_price)}</span>` : ''}
          ${discount ? `<span class="discount-pill">${discount}</span>` : ''}
        </div>
        <div class="meta-row status-${promo.status}">
          <span class="status-dot"></span>
          Achada em ${detectedAt}${revisto} · ${STATUS_LABEL[promo.status] || promo.status}
        </div>
        ${promo.ended_at ? `<div class="ended-note" title="${escapeHtml(promo.ended_reason || '')}">⏹ Promoção finalizada em ${new Date(promo.ended_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${promo.ended_reason ? ` — ${escapeHtml(promo.ended_reason)}` : ''}</div>` : ''}
        <div class="actions">
          <a href="${promo.original_url}" target="_blank" rel="noopener">Abrir original</a>
          ${promo.affiliate_url ? `
            <button data-share-wa="${promo.id}" style="color:var(--good); border-color:var(--good);">📱 WhatsApp</button>
            <button data-share-tg="${promo.id}" style="color:#54a9eb; border-color:#54a9eb;">✈️ Telegram</button>
            <button data-copy-link="${escapeHtml(promo.affiliate_url)}">Copiar link</button>
          ` : ''}
          ${promo.status === 'PENDING' ? `
            <button data-mark-affiliated="${promo.id}">Já afiliei</button>
            <button data-ignore="${promo.id}">Ignorar</button>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

async function markStatus(id, status) {
  const { error } = await client.from('promotions').update({ status }).eq('id', id);
  if (error) { alert('Erro ao atualizar: ' + error.message); return; }
  await loadPromotions();
}

// ---------- busca em dois passos: 1) marketplace  2) só os grupos que rodam nele ----------
let scanChoice = null;
const SCAN_MARKETPLACES = ['shopee', 'netshoes', 'mercadolivre', 'amazon'];

// Grupo sem lista de marketplaces (os antigos) roda em todos.
function groupRunsOn(g, slug) {
  const list = g && g.marketplaces;
  return !Array.isArray(list) || list.length === 0 || list.includes(slug);
}

function groupsFor(slug) {
  return mergeGroupsByName(knownGroups.filter((g) => groupRunsOn(g, slug)));
}

function showScanStep(step) {
  const isGroups = step === 'groups';
  document.getElementById('scanStepMarketplace').style.display = isGroups ? 'none' : 'block';
  document.getElementById('scanStepGroups').style.display = isGroups ? 'block' : 'none';
  document.getElementById('scanModalBack').style.display = isGroups ? '' : 'none';
  document.getElementById('scanModalConfirm').style.display = isGroups ? '' : 'none';
  const msg = document.getElementById('scanModalMsg');
  msg.textContent = '';
  msg.classList.remove('error');
  if (!isGroups) {
    scanChoice = null;
    document.getElementById('scanModalTitle').textContent = 'Buscar promoções';
    document.getElementById('scanModalSub').textContent = 'Escolha o marketplace. Depois você marca só os grupos que fazem sentido para ele.';
  }
}

function renderMarketplacePicks() {
  const container = document.getElementById('scanMpPicks');
  container.innerHTML = SCAN_MARKETPLACES.map((slug) => {
    const label = MARKETPLACE_LABELS[slug] || { name: slug, color: '#888' };
    const n = groupsFor(slug).length;
    const hint = slug === 'amazon'
      ? 'busca por categoria'
      : slug === 'mercadolivre'
        ? `${n} grupo${n === 1 ? '' : 's'} + produtos que você vigia`
        : `${n} grupo${n === 1 ? '' : 's'} configurado${n === 1 ? '' : 's'}`;
    return `
      <button type="button" class="mp-pick" data-mp="${slug}">
        <span class="mp-dotc" style="background:${label.color}; ${label.color === '#000000' ? 'box-shadow:0 0 0 1px var(--line-strong);' : ''}"></span>
        <span class="mp-info">${escapeHtml(label.name)}<small>${hint}</small></span>
        <span class="mp-go">›</span>
      </button>`;
  }).join('');
  container.querySelectorAll('[data-mp]').forEach((btn) => {
    btn.addEventListener('click', () => chooseScanMarketplace(btn.dataset.mp));
  });
}

function chooseScanMarketplace(slug) {
  scanChoice = slug;
  const label = MARKETPLACE_LABELS[slug] || { name: slug };
  showScanStep('groups');
  // showScanStep('groups') não mexe em scanChoice; título/subtítulo ficam por conta daqui
  document.getElementById('scanModalTitle').textContent = `Buscar na ${label.name}`;
  document.getElementById('scanModalSub').textContent = 'Marque o que quer buscar agora. Só aparecem os grupos configurados para rodar neste marketplace.';

  const container = document.getElementById('scanGroupsCheckboxes');
  const selectLinks = document.querySelector('#scanStepGroups .select-links');

  if (slug === 'amazon') {
    selectLinks.style.display = 'none';
    container.innerHTML = '<div class="scan-empty">A Amazon busca por categorias, não por grupos. É só clicar em Buscar.</div>';
    return;
  }
  selectLinks.style.display = '';

  const options = groupsFor(slug).map((g) => ({
    value: g.ids.join(','),
    name: g.name,
    count: g.keywords.length,
    keywords: g.keywords,
  }));
  // No Mercado Livre existem também os produtos que você vigia, que podem estar sem grupo.
  if (slug === 'mercadolivre') options.push({ value: 'none', name: 'Sem grupo (produtos vigiados)', count: null });

  if (!options.length) {
    container.innerHTML = `<div class="scan-empty">Nenhum grupo está configurado para rodar na ${escapeHtml(label.name)}. Vá em <b>Lista de vigilância</b> e marque a caixinha "${escapeHtml(label.name)}" no(s) grupo(s) que quiser.</div>`;
    return;
  }

  container.innerHTML = options.map((g) => {
    const kws = g.keywords || [];
    const attr = (v) => escapeHtml(v).replace(/"/g, '&quot;');
    return `
    <div class="scan-group">
      <div class="scan-group-head">
        <label class="check-row">
          <input type="checkbox" class="scan-group-checkbox" value="${attr(g.value)}" checked />
          <span>${escapeHtml(g.name)}${kws.length ? ` <span style="color:var(--muted); font-size:11.5px;">· ${kws.length} palavra${kws.length === 1 ? '' : 's'}</span>` : ''}</span>
        </label>
        ${kws.length > 1 ? '<button type="button" class="kw-toggle" data-toggle-kws>escolher palavras ▾</button>' : ''}
      </div>
      ${kws.length ? `<div class="scan-kws" style="display:none;">${kws.map((k) => `
        <label class="check-row kw"><input type="checkbox" class="scan-kw-checkbox" value="${attr(k)}" checked /> ${escapeHtml(k)}</label>`).join('')}
      </div>` : ''}
    </div>`;
  }).join('');
}

// Marcar o grupo marca todas as palavras; marcar/desmarcar uma palavra atualiza o grupo (e o "meio marcado").
function onScanGroupsChange(e) {
  const groupEl = e.target.closest('.scan-group');
  if (!groupEl) return;
  const groupCb = groupEl.querySelector('.scan-group-checkbox');
  const kwCbs = [...groupEl.querySelectorAll('.scan-kw-checkbox')];
  if (e.target === groupCb) {
    kwCbs.forEach((c) => { c.checked = groupCb.checked; });
    groupCb.indeterminate = false;
  } else if (e.target.classList.contains('scan-kw-checkbox')) {
    const on = kwCbs.filter((c) => c.checked).length;
    groupCb.checked = on > 0;
    groupCb.indeterminate = on > 0 && on < kwCbs.length;
  }
}

function onScanGroupsClick(e) {
  const btn = e.target.closest('[data-toggle-kws]');
  if (!btn) return;
  const box = btn.closest('.scan-group').querySelector('.scan-kws');
  const open = box.style.display === 'none';
  box.style.display = open ? 'block' : 'none';
  btn.textContent = open ? 'esconder palavras ▴' : 'escolher palavras ▾';
}

function openScanModal() {
  showScanStep('marketplace');
  renderMarketplacePicks();
  document.getElementById('scanModalOverlay').classList.add('show');
}

function setAllScanGroups(checked) {
  document.querySelectorAll('.scan-group-checkbox, .scan-kw-checkbox').forEach((cb) => { cb.checked = checked; cb.indeterminate = false; });
}

function closeScanModal() {
  document.getElementById('scanModalOverlay').classList.remove('show');
}

// Quantas palavras-chave por pedido ao servidor. Cada pedido tem ~48s de limite; em lotes pequenos nenhuma
// palavra fica de fora, e buscar "tudo" rende o mesmo que buscar palavra por palavra.
const SCAN_BATCH_SIZE = { shopee: 6, netshoes: 4, mercadolivre: 6 };

function chunkList(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function postScan(marketplace, body) {
  const res = await fetch(`/api/scan/${marketplace}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const rawText = await res.text();
  let data = null;
  try { data = JSON.parse(rawText); } catch { /* resposta não é JSON */ }
  if (!data) {
    // Acontece quando a Vercel corta a função por tempo (HTML/texto em vez de JSON).
    throw new Error(
      res.status === 504 || res.status === 408
        ? 'A busca demorou mais que o limite do servidor (Vercel) e foi cortada.'
        : `O servidor respondeu algo inesperado (HTTP ${res.status}). Se acabou de atualizar o sistema, confira se o deploy na Vercel terminou.`
    );
  }
  if (!res.ok) throw new Error(data.error || `Falha na busca (HTTP ${res.status})`);
  return data;
}

async function confirmScan() {
  const marketplace = scanChoice;
  if (!marketplace) return;

  // Lê o que foi marcado: grupos (ids) e, dentro deles, as palavras-chave escolhidas.
  const groupIds = [];
  const keywords = [];
  const seenKw = new Set();
  document.querySelectorAll('#scanGroupsCheckboxes .scan-group').forEach((el) => {
    const groupCb = el.querySelector('.scan-group-checkbox');
    const kwCbs = [...el.querySelectorAll('.scan-kw-checkbox')];
    const checkedKws = kwCbs.filter((c) => c.checked);
    const selected = kwCbs.length ? checkedKws.length > 0 : groupCb.checked;
    if (!selected) return;
    groupCb.value.split(',').filter(Boolean).forEach((id) => groupIds.push(id));
    checkedKws.forEach((c) => {
      const k = normKey(c.value);
      if (!seenKw.has(k)) { seenKw.add(k); keywords.push(c.value); }
    });
  });

  const msg = document.getElementById('scanModalMsg');
  const scanResult = document.getElementById('scanResult');
  const confirmBtn = document.getElementById('scanModalConfirm');

  msg.classList.remove('error');
  scanResult.classList.remove('error');

  if (groupIds.length === 0 && marketplace !== 'amazon') {
    msg.textContent = 'Marque pelo menos um grupo (ou uma palavra) antes de buscar.';
    msg.classList.add('error');
    return;
  }

  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Buscando...';

  const marketplaceNames = { mercadolivre: 'Mercado Livre', shopee: 'Shopee', amazon: 'Amazon', netshoes: 'Netshoes' };
  const marketplaceName = marketplaceNames[marketplace] || marketplace;

  const agg = { found: 0, checked: 0, kwDone: 0, notes: [], errors: [], retry: [], failures: 0, lastError: '', categories: undefined };
  const totalKw = keywords.length;

  // Monta os lotes. Amazon busca por categoria (um pedido só). O primeiro lote também confere os produtos vigiados.
  let batches;
  if (marketplace === 'amazon') {
    batches = [{ kws: [], body: { groups: groupIds } }];
  } else {
    const parts = keywords.length ? chunkList(keywords, SCAN_BATCH_SIZE[marketplace] || 5) : [[]];
    batches = parts.map((kws, i) => ({ kws, body: { groups: groupIds, ...(kws.length ? { keywords: kws } : {}), products: i === 0 } }));
  }

  async function runBatches(list) {
    for (const batch of list) {
      msg.textContent = totalKw
        ? `Buscando… ${agg.kwDone} de ${totalKw} palavras feitas · ${agg.found} nova(s) até agora. Não feche a página.`
        : 'Buscando… pode levar até 1 minuto, não feche a página.';
      try {
        const data = await postScan(marketplace, batch.body);
        agg.found += data.promotionsFound ?? 0;
        agg.checked += data.productsChecked ?? 0;
        if (data.categoriesScanned !== undefined) agg.categories = (agg.categories || 0) + data.categoriesScanned;
        const skipped = Array.isArray(data.skippedKeywords) ? data.skippedKeywords : [];
        agg.kwDone += (typeof data.keywordsSearched === 'number' ? data.keywordsSearched : Math.max(0, batch.kws.length - skipped.length));
        skipped.forEach((k) => agg.retry.push(k));
        (data.errors || []).forEach((er) => agg.errors.push(er));
        if (data.note && !agg.notes.includes(data.note)) agg.notes.push(data.note);
      } catch (err) {
        agg.failures += 1;
        agg.lastError = err.message;
        batch.kws.forEach((k) => agg.retry.push(k)); // tenta de novo, em lotes menores, no fim
      }
      await loadPromotions(); // o painel já vai mostrando o que foi achado
    }
  }

  try {
    await runBatches(batches);

    // Uma segunda passada só com o que ficou de fora (limite de tempo ou falha), em lotes menores.
    if (marketplace !== 'amazon' && agg.retry.length) {
      const again = [...new Set(agg.retry)];
      agg.retry = [];
      agg.failures = 0;
      await runBatches(chunkList(again, 2).map((kws) => ({ kws, body: { groups: groupIds, keywords: kws, products: false } })));
    }

    if (agg.kwDone === 0 && agg.checked === 0 && agg.failures > 0 && agg.lastError) throw new Error(agg.lastError);

    const pending = marketplace === 'amazon' ? 0 : Math.max(0, totalKw - agg.kwDone);
    const scannedLabel = agg.categories !== undefined
      ? `${agg.categories} categoria(s)`
      : totalKw ? `${agg.kwDone} de ${totalKw} palavra(s)-chave` : `${agg.checked} produto(s)`;
    const notes = agg.notes.slice(0, 2).join(' ');
    const moreNotes = agg.notes.length > 2 ? ` (+${agg.notes.length - 2} aviso(s))` : '';
    const pendingNote = pending > 0 ? ` — ${pending} palavra(s) não foram buscadas${agg.lastError ? ` (${agg.lastError})` : ''}; clique em buscar de novo para completar` : '';
    const errorSuffix = agg.errors.length ? ` (${agg.errors.length} erro(s): ${String(agg.errors[0]).slice(0, 300)})` : '';
    scanResult.textContent = `${marketplaceName}: ${scannedLabel}, ${agg.found} nova(s)${pendingNote}${notes ? ` — ${notes}${moreNotes}` : ''}${errorSuffix}`;
    if ((agg.errors.length && agg.found === 0) || pending > 0) scanResult.classList.add('error');

    closeScanModal();
    await loadPromotions();
  } catch (err) {
    // O erro aparece no modal E na faixa de resultado do topo (que fica visível depois de fechar).
    msg.textContent = `Erro: ${err.message}`;
    msg.classList.add('error');
    scanResult.textContent = `${marketplaceName}: ${err.message}`;
    scanResult.classList.add('error');
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Buscar';
  }
}

// ---------- produtos repetidos ----------
// Mesma regra do servidor (src/core/dedupe.js): palavras que importam do título + números (300ml, kit 4...).
// Se mudar uma, mude a outra.
const DD_STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'com', 'sem', 'para', 'pra', 'em', 'a', 'o', 'as', 'os', 'um', 'uma',
  'por', 'no', 'na', 'nos', 'nas', 'ou', 'ao', 'aos', 'que', 'mais', 'muito', 'super', 'ate',
  'original', 'originais', 'promocao', 'oferta', 'ofertas', 'lancamento', 'novo', 'nova', 'novos', 'novas',
  'frete', 'gratis', 'envio', 'imediato', 'imediata', 'rapido', 'rapida', 'full', 'barato', 'barata',
  'qualidade', 'premium', 'top', 'melhor', 'pronta', 'pronto', 'entrega', 'brasil', 'oficial',
  'unidade', 'unidades', 'unid', 'und', 'peca', 'pecas', 'pcs', 'pc', 'par', 'pares', 'jogo']);

function ddTokenize(title) {
  const clean = String(title || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const words = new Set();
  const nums = new Set();
  clean.split(' ').forEach((raw) => {
    if (!raw) return;
    if (/\d/.test(raw)) { nums.add(raw.replace(/^x(?=\d)|(?<=\d)x$/g, '')); return; }
    if (raw.length < 3 || DD_STOP.has(raw)) return;
    words.add(raw.length > 4 && raw.endsWith('s') ? raw.slice(0, -1) : raw);
  });
  return { words, nums };
}

function ddSimilar(a, b) {
  if (!a.words.size || !b.words.size) return false;
  if (a.nums.size !== b.nums.size) return false;
  for (const n of a.nums) if (!b.nums.has(n)) return false;
  let shared = 0;
  a.words.forEach((w) => { if (b.words.has(w)) shared += 1; });
  if (!shared) return false;
  const jaccard = shared / (a.words.size + b.words.size - shared);
  const overlap = shared / Math.min(a.words.size, b.words.size);
  return (shared >= 2 && jaccard >= 0.6) || (shared >= 4 && overlap >= 0.8);
}

// Junta os anúncios do MESMO produto (dentro do mesmo marketplace). Fica o já afiliado; senão o mais barato.
function collapseDuplicates(list) {
  const byMp = new Map(); // marketplace_id -> grupos de anúncios iguais (só compara dentro do mesmo marketplace)
  const order = [];
  list.forEach((p) => {
    if (!p._tok) p._tok = ddTokenize(p.title);
    const tok = p._tok;
    if (!byMp.has(p.marketplace_id)) byMp.set(p.marketplace_id, []);
    const groups = byMp.get(p.marketplace_id);
    const g = groups.find((x) => ddSimilar(tok, x.tok));
    if (!g) {
      const ng = { tok, rep: p, extra: 0 };
      groups.push(ng);
      order.push(ng);
      return;
    }
    g.extra += 1;
    const better = (p.status === 'AFFILIATED' && g.rep.status !== 'AFFILIATED')
      || ((p.status === 'AFFILIATED') === (g.rep.status === 'AFFILIATED') && Number(p.current_price) < Number(g.rep.current_price));
    if (better) g.rep = p;
  });
  return order.map((g) => (g.extra ? { ...g.rep, _dupCount: g.extra } : g.rep));
}

async function cleanDuplicates() {
  if (!confirm('Marcar como IGNORADAS as promoções repetidas (mesmo produto, vários vendedores)?\n\nFica uma de cada: a que você já afiliou ou, se não houver, a mais barata. Quem já está afiliada não é mexida.')) return;
  const btn = document.getElementById('dedupeBtn');
  const out = document.getElementById('scanResult');
  btn.disabled = true;
  out.classList.remove('error');
  out.textContent = 'Procurando repetidos...';
  try {
    const res = await fetch('/api/promotions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'dedupe' }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    out.textContent = `Limpeza feita: ${data.checked} promoção(ões) conferidas, ${data.ignored} repetida(s) marcada(s) como ignorada(s).`;
    await loadPromotions();
  } catch (err) {
    out.classList.add('error');
    out.textContent = `Não consegui limpar: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

const MESSAGE_OPENERS = ['🔥 OLHA ESSA OFERTA!', '🎯 Achado do dia:', '⚡ Promoção boa de aproveitar:', '👀 Vale a pena ver isso:'];

function buildShareMessage(promo, { includeLink = true } = {}) {
  // Varia o texto de abertura pra não ficar sempre igual — escolhido meio
  // aleatório, baseado no id da promoção (fica igual toda vez que você
  // clicar na MESMA promoção, mas muda de uma promoção pra outra).
  const seed = [...promo.id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const opener = MESSAGE_OPENERS[seed % MESSAGE_OPENERS.length];

  const priceLine = promo.previous_price
    ? `De R$ ${formatPrice(promo.previous_price)} por *R$ ${formatPrice(promo.current_price)}*${promo.discount_rate ? ` (${Math.round(promo.discount_rate)}% OFF)` : ''}`
    : `Por *R$ ${formatPrice(promo.current_price)}*`;

  const lines = [opener, '', promo.title, '', priceLine];
  if (includeLink) {
    lines.push('', `👉 ${promo.affiliate_url || promo.original_url}`);
  }
  return lines.join('\n');
}

function formatPrice(value) {
  return Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

init();
