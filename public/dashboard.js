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
let allPromotions = [];

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
  document.getElementById('clearFilters').addEventListener('click', () => {
    currentMarketplace = 'ALL';
    currentGroup = 'ALL';
    document.getElementById('marketplaceFilter').value = 'ALL';
    document.getElementById('groupFilter').value = 'ALL';
    render();
  });

  document.getElementById('scanBtn').addEventListener('click', runScan);

  loadFilterOptions();
  loadPromotions();
  setInterval(loadPromotions, 60000); // só relê o que já está salvo — não dispara nova busca
}

async function loadFilterOptions() {
  const { data: marketplaces } = await client.from('marketplaces').select('slug, name').order('name');
  const mpSelect = document.getElementById('marketplaceFilter');
  (marketplaces || []).forEach((mp) => {
    const opt = document.createElement('option');
    opt.value = mp.slug;
    opt.textContent = MARKETPLACE_LABELS[mp.slug]?.name || mp.name;
    mpSelect.appendChild(opt);
  });

  const { data: groups } = await client.from('watch_groups').select('id, name').order('name');
  const groupSelect = document.getElementById('groupFilter');
  (groups || []).forEach((g) => {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name;
    groupSelect.appendChild(opt);
  });
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

async function runScan() {
  const btn = document.getElementById('scanBtn');
  const resultEl = document.getElementById('scanResult');
  btn.disabled = true;
  btn.textContent = 'Buscando...';
  resultEl.textContent = '';

  const results = await Promise.allSettled([
    fetch('/api/scan/mercadolivre').then((r) => r.json().then((data) => ({ ok: r.ok, data, name: 'Mercado Livre' }))),
    fetch('/api/scan/shopee').then((r) => r.json().then((data) => ({ ok: r.ok, data, name: 'Shopee' }))),
  ]);

  const parts = results.map((result) => {
    if (result.status !== 'fulfilled') return `Erro inesperado: ${result.reason}`;
    const { ok, data, name } = result.value;
    if (!ok) return `${name}: erro — ${data.error || 'falha desconhecida'}`;
    const found = data.promotionsFound ?? 0;
    const scannedLabel = data.categoriesScanned !== undefined
      ? `${data.categoriesScanned} categoria(s)`
      : `${data.groupsSearched ?? data.productsChecked ?? 0} grupo(s)/produto(s)`;
    return `${name}: ${scannedLabel}, ${found} nova(s)`;
  });

  resultEl.textContent = parts.join(' · ');
  await loadPromotions();

  btn.disabled = false;
  btn.textContent = 'Buscar promoções agora';
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
