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

let client = null;
let currentStatus = 'ALL';
let currentMarketplace = 'ALL';
let currentGroup = 'ALL';
let currentKeyword = 'ALL';
let currentDateFilter = 'TODAY';
let allPromotions = [];
let knownGroups = [];

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

  // Cascata: Marketplace -> Grupo -> Palavra-chave. Cada um só oferece o que existe no nível de cima.
  document.getElementById('marketplaceFilter').addEventListener('change', (e) => {
    currentMarketplace = e.target.value;
    currentKeyword = 'ALL';
    refreshGroupKeywordOptions();
    render();
  });
  document.getElementById('groupFilter').addEventListener('change', (e) => {
    currentGroup = e.target.value;
    currentKeyword = 'ALL';
    refreshGroupKeywordOptions();
    render();
  });
  document.getElementById('keywordFilter').addEventListener('change', (e) => {
    currentKeyword = e.target.value;
    render();
  });
  document.getElementById('dateFilter').addEventListener('change', (e) => {
    currentDateFilter = e.target.value;
    document.getElementById('customDateRange').classList.toggle('show', currentDateFilter === 'CUSTOM');
    render();
  });
  document.getElementById('dateFrom').addEventListener('change', render);
  document.getElementById('dateTo').addEventListener('change', render);
  document.getElementById('clearFilters').addEventListener('click', () => {
    currentMarketplace = 'ALL';
    currentGroup = 'ALL';
    currentKeyword = 'ALL';
    currentDateFilter = 'TODAY';
    document.getElementById('marketplaceFilter').value = 'ALL';
    refreshGroupKeywordOptions();
    document.getElementById('dateFilter').value = 'TODAY';
    document.getElementById('customDateRange').classList.remove('show');
    render();
  });

  document.getElementById('scanBtn').addEventListener('click', openScanModal);
  document.getElementById('dedupeBtn').addEventListener('click', cleanDuplicates);
  document.getElementById('scanModalCancel').addEventListener('click', closeScanModal);
  document.getElementById('scanModalConfirm').addEventListener('click', confirmScan);
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

  const mpSelect = document.getElementById('marketplaceFilter');
  const mpPrevValue = mpSelect.value;
  mpSelect.innerHTML = '<option value="ALL">Todos</option>';
  (marketplaces || []).forEach((mp) => {
    const opt = document.createElement('option');
    opt.value = mp.slug;
    opt.textContent = MARKETPLACE_LABELS[mp.slug]?.name || mp.name;
    mpSelect.appendChild(opt);
  });
  if ([...mpSelect.options].some((o) => o.value === mpPrevValue)) mpSelect.value = mpPrevValue;

  // "marketplaces" diz em quais marketplaces o grupo roda. Se a coluna ainda não existir (SQL 0008 não rodado), lê sem ela.
  let { data: groups, error: groupError } = await client.from('watch_groups').select('id, name, search_keyword, marketplaces').order('name');
  if (groupError) {
    ({ data: groups, error: groupError } = await client.from('watch_groups').select('id, name, search_keyword').order('name'));
  }
  if (groupError) { showFatalError(`Erro ao carregar grupos: ${groupError.message}`); return; }

  knownGroups = groups || [];
  refreshGroupKeywordOptions();
  render();
}

function normKey(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
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

// ---------- Filtros em cascata: Marketplace -> Grupo -> Palavra-chave ----------
// - Marketplace escolhido -> o filtro de grupo só lista os grupos que rodam nele.
// - Grupo escolhido       -> o filtro de palavra-chave lista, uma por uma (como no cadastro), as palavras daquele grupo.
// - Sem grupo escolhido   -> o filtro de palavra-chave fica travado (escolha um grupo primeiro).
const KEYWORD_MARKETPLACES = ['shopee', 'netshoes', 'mercadolivre'];

function groupsForCurrentMarketplace() {
  const rows = (currentMarketplace === 'ALL' || !KEYWORD_MARKETPLACES.includes(currentMarketplace))
    ? knownGroups
    : knownGroups.filter((g) => groupRunsOn(g, currentMarketplace));
  return mergeGroupsByName(rows);
}

function refreshGroupKeywordOptions() {
  const groupSelect = document.getElementById('groupFilter');
  const keywordSelect = document.getElementById('keywordFilter');
  const groups = groupsForCurrentMarketplace();

  // Se o grupo escolhido não roda no marketplace escolhido, volta para "Todos".
  if (currentGroup !== 'ALL' && !groups.some((g) => g.key === currentGroup)) { currentGroup = 'ALL'; currentKeyword = 'ALL'; }

  groupSelect.innerHTML = '<option value="ALL">Todos</option>' + groups.map((g) =>
    `<option value="${escapeHtml(g.key)}">${escapeHtml(g.name)} (${g.keywords.length})</option>`).join('');
  groupSelect.value = currentGroup;

  const chosen = groups.find((g) => g.key === currentGroup);
  if (!chosen) {
    currentKeyword = 'ALL';
    keywordSelect.innerHTML = '<option value="ALL">Escolha um grupo primeiro</option>';
    keywordSelect.disabled = true;
    keywordSelect.title = 'Escolha um grupo para filtrar pelas palavras-chave dele';
    return;
  }
  const kws = [...chosen.keywords].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  if (currentKeyword !== 'ALL' && !kws.some((k) => normKey(k) === currentKeyword)) currentKeyword = 'ALL';
  keywordSelect.innerHTML = `<option value="ALL">Todas as ${kws.length} palavras</option>` + kws.map((k) =>
    `<option value="${escapeHtml(normKey(k))}">${escapeHtml(k)}</option>`).join('');
  keywordSelect.value = currentKeyword;
  keywordSelect.disabled = false;
  keywordSelect.title = '';
}

// IDs de banco do grupo escolhido (um grupo "unificado" pode ter várias linhas com o mesmo nome).
function matchingGroupIds() {
  if (currentGroup === 'ALL') return null;
  return new Set(knownGroups.filter((g) => normKey(g.name) === currentGroup).map((g) => g.id));
}

async function loadPromotions() {
  const { data, error } = await client
    .from('promotions')
    .select('*, marketplaces(slug, name, logo_url), watch_groups(name, search_keyword)')
    .order('detected_at', { ascending: false })
    .limit(300);

  if (error) {
    showFatalError(`Erro ao carregar as promoções: ${error.message}`);
    return;
  }

  allPromotions = data || [];
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

function render() {
  const grid = document.getElementById('grid');
  const empty = document.getElementById('empty');

  // Base = tudo que passa nos filtros (marketplace, grupo, palavra-chave, data), ainda sem a aba de status.
  let base = allPromotions;
  if (currentMarketplace !== 'ALL') base = base.filter((p) => p.marketplaces?.slug === currentMarketplace);
  const groupIds = matchingGroupIds();
  if (groupIds) base = base.filter((p) => p.watch_group_id && groupIds.has(p.watch_group_id));
  if (currentKeyword !== 'ALL') base = base.filter((p) => normKey(p.matched_keyword || '') === currentKeyword);
  base = applyDateFilter(base);

  // O mesmo produto vendido por vários vendedores aparece UMA vez só (a mais barata, ou a que você já afiliou),
  // com um aviso de quantos anúncios iguais existem. As ignoradas ficam só na aba "Ignoradas".
  const ignored = base.filter((p) => p.status === 'IGNORED');
  const visible = collapseDuplicates(base.filter((p) => p.status !== 'IGNORED'));

  // Contadores só mostram número quando há promoção de fato na tela; acompanham os filtros em tempo real.
  const hasResults = visible.length > 0;
  document.getElementById('countAll').textContent = hasResults ? visible.length : '–';
  document.getElementById('countPending').textContent = hasResults ? visible.filter((p) => p.status === 'PENDING').length : '–';
  document.getElementById('countAffiliated').textContent = hasResults ? visible.filter((p) => p.status === 'AFFILIATED').length : '–';

  let list = visible;
  if (currentStatus === 'IGNORED') list = ignored;
  else if (currentStatus !== 'ALL') list = visible.filter((p) => p.status === currentStatus);

  if (list.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  grid.innerHTML = list.map(renderCard).join('');

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

function applyDateFilter(list) {
  if (currentDateFilter === 'ALL') return list;

  const today = new Date();
  const todayKey = toLocalDateKey(today);

  if (currentDateFilter === 'TODAY') {
    // Só o que foi encontrado pela PRIMEIRA vez hoje (produto reencontrado não conta como novo).
    return list.filter((p) => toLocalDateKey(p.detected_at) === todayKey);
  }

  if (currentDateFilter === 'TODAY_SEEN') {
    // Tudo que a busca viu hoje, inclusive produtos antigos que apareceram de novo.
    return list.filter((p) => toLocalDateKey(p.last_seen_at || p.detected_at) === todayKey);
  }

  if (currentDateFilter === 'YESTERDAY') {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yKey = toLocalDateKey(yesterday);
    return list.filter((p) => toLocalDateKey(p.detected_at) === yKey);
  }

  if (currentDateFilter === 'CUSTOM') {
    const from = document.getElementById('dateFrom').value;
    const to = document.getElementById('dateTo').value;
    return list.filter((p) => {
      const key = toLocalDateKey(p.detected_at);
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
    <div class="card">
      <div class="card-media">
        <div class="tag-row">
          <span class="tag" style="background:${label.color}; color:${label.textColor}">${label.name}</span>
          ${groupName ? `<span class="tag-group">${escapeHtml(groupName)}</span>` : ''}
        </div>
        <img src="${promo.image_url || ''}" alt="${escapeHtml(promo.title)}" loading="lazy" />
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(promo.title)}</div>
        ${keyword ? `<div class="kw-pill" title="${escapeHtml(kwTip)}"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><span>${escapeHtml(keyword)}</span></div>` : ''}
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
  }));
  // No Mercado Livre existem também os produtos que você vigia, que podem estar sem grupo.
  if (slug === 'mercadolivre') options.push({ value: 'none', name: 'Sem grupo (produtos vigiados)', count: null });

  if (!options.length) {
    container.innerHTML = `<div class="scan-empty">Nenhum grupo está configurado para rodar na ${escapeHtml(label.name)}. Vá em <b>Lista de vigilância</b> e marque a caixinha "${escapeHtml(label.name)}" no(s) grupo(s) que quiser.</div>`;
    return;
  }

  container.innerHTML = options.map((g) => `
    <label class="check-row">
      <input type="checkbox" class="scan-group-checkbox" value="${escapeHtml(g.value)}" checked />
      ${escapeHtml(g.name)}${g.count ? ` <span style="color:var(--muted); font-size:11.5px;">· ${g.count} palavra${g.count === 1 ? '' : 's'}</span>` : ''}
    </label>
  `).join('');
}

function openScanModal() {
  showScanStep('marketplace');
  renderMarketplacePicks();
  document.getElementById('scanModalOverlay').classList.add('show');
}

function setAllScanGroups(checked) {
  document.querySelectorAll('.scan-group-checkbox').forEach((cb) => { cb.checked = checked; });
}

function closeScanModal() {
  document.getElementById('scanModalOverlay').classList.remove('show');
}

async function confirmScan() {
  const marketplace = scanChoice;
  if (!marketplace) return;

  // Cada caixinha pode carregar vários ids ("id1,id2,id3") — junta tudo numa lista só.
  const groupIds = [...document.querySelectorAll('.scan-group-checkbox:checked')]
    .flatMap((cb) => cb.value.split(','))
    .filter(Boolean);
  const msg = document.getElementById('scanModalMsg');
  const scanResult = document.getElementById('scanResult');
  const confirmBtn = document.getElementById('scanModalConfirm');

  msg.classList.remove('error');
  scanResult.classList.remove('error');

  if (groupIds.length === 0 && marketplace !== 'amazon') {
    msg.textContent = 'Marque pelo menos um grupo antes de buscar.';
    msg.classList.add('error');
    return;
  }

  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Buscando...';
  msg.textContent = 'Buscando… pode levar até 1 minuto, não feche a página.';

  const marketplaceNames = { mercadolivre: 'Mercado Livre', shopee: 'Shopee', amazon: 'Amazon', netshoes: 'Netshoes' };
  const marketplaceName = marketplaceNames[marketplace] || marketplace;

  try {
    // POST com a lista no corpo: não tem limite de tamanho de endereço, mesmo com muitos grupos.
    const res = await fetch(`/api/scan/${marketplace}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups: groupIds }),
    });

    const rawText = await res.text();
    let data = null;
    try { data = JSON.parse(rawText); } catch { /* resposta não é JSON */ }

    if (!data) {
      // Acontece quando a Vercel corta a função por tempo (HTML/texto em vez de JSON).
      throw new Error(
        res.status === 504 || res.status === 408
          ? 'A busca demorou mais que o limite do servidor (Vercel) e foi cortada. Clique em buscar de novo — o que já foi salvo não se perde.'
          : `O servidor respondeu algo inesperado (HTTP ${res.status}). Se acabou de atualizar o sistema, confira se o deploy na Vercel terminou.`
      );
    }
    if (!res.ok) throw new Error(data.error || `Falha na busca (HTTP ${res.status})`);

    const found = data.promotionsFound ?? 0;
    const scannedLabel = data.categoriesScanned !== undefined
      ? `${data.categoriesScanned} categoria(s)`
      : `${data.groupsSearched ?? data.productsChecked ?? 0} grupo(s)/produto(s)`;

    const noteSuffix = data.note ? ` — ${data.note}` : '';
    const errorSuffix = data.errors?.length
      ? ` (${data.errors.length} erro(s): ${String(data.errors[0]).slice(0, 300)})`
      : '';
    scanResult.textContent = `${marketplaceName}: ${scannedLabel}, ${found} nova(s)${noteSuffix}${errorSuffix}`;
    if (data.errors?.length && found === 0) scanResult.classList.add('error');

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
  const groups = [];
  list.forEach((p) => {
    const tok = ddTokenize(p.title);
    const g = groups.find((x) => x.mp === p.marketplace_id && ddSimilar(tok, x.tok));
    if (!g) { groups.push({ mp: p.marketplace_id, tok, rep: p, extra: 0 }); return; }
    g.extra += 1;
    const better = (p.status === 'AFFILIATED' && g.rep.status !== 'AFFILIATED')
      || ((p.status === 'AFFILIATED') === (g.rep.status === 'AFFILIATED') && Number(p.current_price) < Number(g.rep.current_price));
    if (better) g.rep = p;
  });
  return groups.map((g) => (g.extra ? { ...g.rep, _dupCount: g.extra } : g.rep));
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
