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
let currentFilter = 'ALL';
let allPromotions = [];

function showFatalError(message) {
  const box = document.getElementById('fatalError');
  box.style.display = 'block';
  box.innerHTML = `<strong>O painel não conseguiu iniciar.</strong><br>${message}`;
}

function init() {
  if (typeof supabase === 'undefined') {
    showFatalError(
      'A biblioteca do Supabase não carregou (verifique sua internet e recarregue a página).'
    );
    return;
  }

  if (
    !window.RADAR_CONFIG ||
    !window.RADAR_CONFIG.SUPABASE_URL ||
    !window.RADAR_CONFIG.SUPABASE_ANON_KEY ||
    window.RADAR_CONFIG.SUPABASE_URL.includes('SEU-PROJETO')
  ) {
    showFatalError(
      'O arquivo <code>public/config.js</code> ainda não está preenchido com a URL e a chave reais do Supabase.'
    );
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
      currentFilter = btn.dataset.status;
      render();
    });
  });

  document.getElementById('scanBtn').addEventListener('click', runScan);

  loadPromotions();
  setInterval(loadPromotions, 60000); // só relê o que já está salvo — não dispara nova busca no ML
}

async function loadPromotions() {
  const { data, error } = await client
    .from('promotions')
    .select('*, marketplaces(slug, name, logo_url)')
    .order('detected_at', { ascending: false })
    .limit(200);

  if (error) {
    showFatalError(`Erro ao carregar as promoções: ${error.message}`);
    return;
  }

  allPromotions = data || [];
  render();
}

function render() {
  const grid = document.getElementById('grid');
  const empty = document.getElementById('empty');

  document.getElementById('countAll').textContent = allPromotions.length;
  document.getElementById('countPending').textContent = allPromotions.filter((p) => p.status === 'PENDING').length;
  document.getElementById('countAffiliated').textContent = allPromotions.filter((p) => p.status === 'AFFILIATED').length;

  const list = currentFilter === 'ALL' ? allPromotions : allPromotions.filter((p) => p.status === currentFilter);

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
}

function renderCard(promo) {
  const slug = promo.marketplaces?.slug || 'desconhecido';
  const label = MARKETPLACE_LABELS[slug] || { name: slug, color: '#444', textColor: '#fff' };
  const detectedAt = new Date(promo.detected_at).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const discount = promo.discount_rate ? `-${Math.round(promo.discount_rate)}%` : '';

  return `
    <div class="card">
      <div class="card-media">
        <span class="tag" style="background:${label.color}; color:${label.textColor}">${label.name}</span>
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
          Detectada em ${detectedAt} · ${STATUS_LABEL[promo.status] || promo.status}
        </div>
        <div class="actions">
          <a href="${promo.original_url}" target="_blank" rel="noopener">Abrir original</a>
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

  try {
    const res = await fetch('/api/scan/mercadolivre');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha na busca');

    resultEl.textContent = `Varreu ${data.categoriesScanned} categoria(s) e encontrou ${data.promotionsFound} promoção(ões) nova(s).`;
    if (data.errors && data.errors.length) {
      resultEl.textContent += ` (${data.errors.length} erro(s) — veja integration_logs no Supabase)`;
    }
    await loadPromotions();
  } catch (err) {
    resultEl.textContent = `Erro ao buscar: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Buscar promoções agora';
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
