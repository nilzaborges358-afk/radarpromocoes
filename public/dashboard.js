const MARKETPLACE_LABELS = {
  mercadolivre: { name: 'Mercado Livre', color: '#fff159', textColor: '#1a1a1a' },
  shopee: { name: 'Shopee', color: '#ee4d2d', textColor: '#fff' },
  amazon: { name: 'Amazon', color: '#ff9900', textColor: '#1a1a1a' },
  magalu: { name: 'Magalu', color: '#0086ff', textColor: '#fff' },
  tiktokshop: { name: 'TikTok Shop', color: '#010101', textColor: '#fff' },
  netshoes: { name: 'Netshoes', color: '#f5761a', textColor: '#fff' },
};

const STATUS_LABEL = { PENDING: 'aguardando afiliação', AFFILIATED: 'afiliada', IGNORED: 'ignorada' };

let client = null;
let currentStatus = 'ALL';
let currentMarketplace = 'ALL';
let currentGroup = 'ALL';
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

  document.getElementById('marketplaceFilter').addEventListener('change', (e) => {
    currentMarketplace = e.target.value;
    render();
  });
  document.getElementById('groupFilter').addEventListener('change', (e) => {
    currentGroup = e.target.value;
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
    currentDateFilter = 'TODAY';
    document.getElementById('marketplaceFilter').value = 'ALL';
    document.getElementById('groupFilter').value = 'ALL';
    document.getElementById('dateFilter').value = 'TODAY';
    document.getElementById('customDateRange').classList.remove('show');
    render();
  });

  document.getElementById('scanBtn').addEventListener('click', openScanModal);
  document.getElementById('scanModalCancel').addEventListener('click', closeScanModal);
  document.getElementById('scanModalConfirm').addEventListener('click', confirmScan);
  document.querySelectorAll('input[name="scanMarketplace"]').forEach((radio) => {
    radio.addEventListener('change', updateScanConfirmState);
  });

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

  const { data: groups, error: groupError } = await client.from('watch_groups').select('id, name').order('name');
  if (groupError) { showFatalError(`Erro ao carregar grupos: ${groupError.message}`); return; }

  knownGroups = groups || [];
  const groupSelect = document.getElementById('groupFilter');
  const groupPrevValue = groupSelect.value;
  groupSelect.innerHTML = '<option value="ALL">Todos</option>';
  knownGroups.forEach((g) => {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name;
    groupSelect.appendChild(opt);
  });
  if ([...groupSelect.options].some((o) => o.value === groupPrevValue)) groupSelect.value = groupPrevValue;
}

async function loadPromotions() {
  const { data, error } = await client
    .from('promotions')
    .select('*, marketplaces(slug, name, logo_url), watch_groups(name)')
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

  document.getElementById('countAll').textContent = allPromotions.length;
  document.getElementById('countPending').textContent = allPromotions.filter((p) => p.status === 'PENDING').length;
  document.getElementById('countAffiliated').textContent = allPromotions.filter((p) => p.status === 'AFFILIATED').length;

  let list = allPromotions;
  if (currentStatus !== 'ALL') list = list.filter((p) => p.status === currentStatus);
  if (currentMarketplace !== 'ALL') list = list.filter((p) => p.marketplaces?.slug === currentMarketplace);
  if (currentGroup !== 'ALL') list = list.filter((p) => p.watch_group_id === currentGroup);
  list = applyDateFilter(list);

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
    return list.filter((p) => toLocalDateKey(p.detected_at) === todayKey);
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
  const slug = promo.marketplaces?.slug;
  const label = MARKETPLACE_LABELS[slug] || { name: promo.marketplaces?.name || 'Marketplace', color: '#444', textColor: '#fff' };
  const groupName = promo.watch_groups?.name;
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
        <div class="price-row">
          <span class="price-current">R$ ${formatPrice(promo.current_price)}</span>
          ${promo.previous_price ? `<span class="price-previous">R$ ${formatPrice(promo.previous_price)}</span>` : ''}
          ${discount ? `<span class="discount-pill">${discount}</span>` : ''}
        </div>
        <div class="meta-row status-${promo.status}">
          <span class="status-dot"></span>
          Buscada em ${detectedAt} · ${STATUS_LABEL[promo.status] || promo.status}
        </div>
        <div class="actions">
          <a href="${promo.original_url}" target="_blank" rel="noopener">Abrir original</a>
          ${promo.affiliate_url ? `<button data-copy-link="${escapeHtml(promo.affiliate_url)}" style="color:var(--good); border-color:var(--good);">Copiar link de afiliado</button>` : ''}
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

function openScanModal() {
  // Monta as checkboxes de grupo (+ "Sem grupo"), todas marcadas por padrão.
  const container = document.getElementById('scanGroupsCheckboxes');
  const groupOptions = [...knownGroups.map((g) => ({ id: g.id, name: g.name })), { id: 'none', name: 'Sem grupo' }];

  container.innerHTML = groupOptions.map((g) => `
    <label class="check-row">
      <input type="checkbox" class="scan-group-checkbox" value="${g.id}" checked /> ${escapeHtml(g.name)}
    </label>
  `).join('');

  document.querySelectorAll('input[name="scanMarketplace"]').forEach((r) => { r.checked = false; });
  document.getElementById('scanModalMsg').textContent = '';
  updateScanConfirmState();
  document.getElementById('scanModalOverlay').classList.add('show');
}

function closeScanModal() {
  document.getElementById('scanModalOverlay').classList.remove('show');
}

function updateScanConfirmState() {
  const selected = document.querySelector('input[name="scanMarketplace"]:checked');
  document.getElementById('scanModalConfirm').disabled = !selected;
}

async function confirmScan() {
  const marketplace = document.querySelector('input[name="scanMarketplace"]:checked')?.value;
  if (!marketplace) return;

  const groupIds = [...document.querySelectorAll('.scan-group-checkbox:checked')].map((cb) => cb.value);
  const msg = document.getElementById('scanModalMsg');
  const confirmBtn = document.getElementById('scanModalConfirm');

  if (groupIds.length === 0) {
    msg.textContent = 'Marque pelo menos um grupo (ou "Sem grupo") antes de buscar.';
    return;
  }

  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Buscando...';
  msg.textContent = '';

  const marketplaceName = marketplace === 'mercadolivre' ? 'Mercado Livre' : 'Shopee';

  try {
    const res = await fetch(`/api/scan/${marketplace}?groups=${groupIds.join(',')}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha na busca');

    const found = data.promotionsFound ?? 0;
    const scannedLabel = data.categoriesScanned !== undefined
      ? `${data.categoriesScanned} categoria(s)`
      : `${data.groupsSearched ?? data.productsChecked ?? 0} grupo(s)/produto(s)`;

    document.getElementById('scanResult').textContent = `${marketplaceName}: ${scannedLabel}, ${found} nova(s)` +
      (data.errors?.length ? ` (${data.errors.length} erro(s) — veja integration_logs)` : '');

    closeScanModal();
    await loadPromotions();
  } catch (err) {
    msg.textContent = `Erro: ${err.message}`;
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Buscar';
  }
}

function formatPrice(value) {
  return Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

init();
