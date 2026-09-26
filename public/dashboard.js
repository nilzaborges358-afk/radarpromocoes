const { createClient } = supabase;
const client = createClient(window.RADAR_CONFIG.SUPABASE_URL, window.RADAR_CONFIG.SUPABASE_ANON_KEY);

const MARKETPLACE_LABELS = {
  mercadolivre: { name: 'Mercado Livre', color: '#fff159', textColor: '#1a1a1a' },
  shopee: { name: 'Shopee', color: '#ee4d2d', textColor: '#fff' },
  amazon: { name: 'Amazon', color: '#ff9900', textColor: '#1a1a1a' },
  magalu: { name: 'Magalu', color: '#0086ff', textColor: '#fff' },
  tiktokshop: { name: 'TikTok Shop', color: '#010101', textColor: '#fff' },
  netshoes: { name: 'Netshoes', color: '#f5761a', textColor: '#fff' },
};

let currentFilter = 'ALL';
let allPromotions = [];

async function loadPromotions() {
  const { data, error } = await client
    .from('promotions')
    .select('*, marketplaces(slug, name, logo_url)')
    .order('detected_at', { ascending: false })
    .limit(200);

  if (error) {
    console.error(error);
    document.getElementById('grid').innerHTML = `<p style="color:#f66">Erro ao carregar: ${error.message}</p>`;
    return;
  }

  allPromotions = data || [];
  render();
}

function render() {
  const grid = document.getElementById('grid');
  const empty = document.getElementById('empty');
  const list = currentFilter === 'ALL'
    ? allPromotions
    : allPromotions.filter((p) => p.status === currentFilter);

  document.getElementById('count').textContent = `${list.length} promoção(ões)`;

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
  const detectedAt = new Date(promo.detected_at).toLocaleString('pt-BR');
  const discount = promo.discount_rate ? `-${Math.round(promo.discount_rate)}%` : '';

  return `
    <div class="card">
      <img src="${promo.image_url || ''}" alt="${escapeHtml(promo.title)}" loading="lazy" />
      <div class="card-body">
        <span class="badge" style="background:${label.color}; color:${label.textColor}">${label.name}</span>
        <div class="title">${escapeHtml(promo.title)}</div>
        <div class="prices">
          ${promo.previous_price ? `<span class="price-old">R$ ${formatPrice(promo.previous_price)}</span>` : ''}
          <span class="price-new">R$ ${formatPrice(promo.current_price)}</span>
          ${discount ? `<span class="discount">${discount}</span>` : ''}
        </div>
        <div class="meta">
          Detectada em ${detectedAt} ·
          <span class="status-pill status-${promo.status}">${statusLabel(promo.status)}</span>
        </div>
        <div class="actions">
          <a class="btn-open" href="${promo.original_url}" target="_blank" rel="noopener">Abrir original</a>
          ${promo.status === 'PENDING' ? `
            <button class="btn-done" data-mark-affiliated="${promo.id}">Já afiliei</button>
            <button class="btn-done" data-ignore="${promo.id}">Ignorar</button>
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

function statusLabel(status) {
  return { PENDING: 'aguardando afiliação', AFFILIATED: 'afiliada', IGNORED: 'ignorada' }[status] || status;
}

function formatPrice(value) {
  return Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

document.querySelectorAll('#filters button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#filters button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.status;
    render();
  });
});

loadPromotions();
setInterval(loadPromotions, 60000); // atualiza sozinho a cada 1 minuto
