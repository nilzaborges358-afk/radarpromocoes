let groups = [];        // linhas cruas do banco (podem ter nomes repetidos)
let mergedGroups = []; // grupos já unificados por nome — é isso que aparece na tela
let products = [];
let marketplaces = [];

async function load() {
  try {
    const res = await fetch('/api/watchlist');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao carregar');
    groups = data.groups;
    mergedGroups = mergeGroupsByName(groups);
    products = data.products;
    marketplaces = data.marketplaces || [];
    renderGroupSelect();
    renderGroupsList();
    renderList();
    renderManualFormOptions();
  } catch (err) {
    document.getElementById('groups').innerHTML = `<p style="color:#e2604a; padding: 0 32px;">Erro ao carregar: ${err.message}</p>`;
  }
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normKey(value) {
  return cleanText(value).toLowerCase();
}

// Tudo que tem o MESMO nome vira UM grupo só, com todas as palavras-chave somadas (sem repetir).
// Devolve [{ key, name, ids: [ids do banco], keywords: [...] }].
function mergeGroupsByName(rows) {
  const map = new Map();
  (rows || []).forEach((g) => {
    const key = normKey(g.name);
    if (!map.has(key)) map.set(key, { key, name: cleanText(g.name), ids: [], keywords: [] });
    const merged = map.get(key);
    merged.ids.push(g.id);
    // Se as linhas diferem só em maiúscula/minúscula, mostra a variante com inicial maiúscula.
    if (!/[A-ZÀ-Þ]/.test(merged.name) && /[A-ZÀ-Þ]/.test(cleanText(g.name))) merged.name = cleanText(g.name);
    String(g.search_keyword || g.name || '').split(',').map(cleanText).filter(Boolean).forEach((kw) => {
      if (!merged.keywords.some((k) => normKey(k) === normKey(kw))) merged.keywords.push(kw);
    });
  });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

function renderGroupSelect() {
  const select = document.getElementById('groupSelect');
  select.innerHTML =
    `<option value="">Sem grupo</option>` +
    mergedGroups.map((g) => `<option value="${g.ids[0]}">${escapeHtml(g.name)}</option>`).join('');
}

function renderGroupsList() {
  const container = document.getElementById('groupsList');
  if (mergedGroups.length === 0) {
    container.innerHTML = `<p style="color:var(--muted); font-size:12px;">Nenhum grupo criado ainda.</p>`;
    return;
  }
  container.innerHTML = mergedGroups.map((g) => `
    <div class="group-row">
      <div class="g-info">
        <div class="g-name">${escapeHtml(g.name)} <span class="g-count">${g.keywords.length} palavra${g.keywords.length === 1 ? '' : 's'}-chave</span></div>
        <div class="g-keywords">
          ${g.keywords.map((kw, i) => `
            <span class="kw-chip">${escapeHtml(kw)}${g.keywords.length > 1
              ? `<button class="kw-remove" title="Tirar essa palavra-chave" data-remove-kw="${escapeHtml(g.key)}" data-kw-index="${i}">×</button>`
              : ''}</span>`).join('')}
        </div>
      </div>
      <button class="remove" data-remove-group="${escapeHtml(g.key)}">Remover grupo</button>
    </div>
  `).join('');

  container.querySelectorAll('[data-remove-group]').forEach((btn) => {
    btn.addEventListener('click', () => removeGroup(btn.dataset.removeGroup));
  });
  container.querySelectorAll('[data-remove-kw]').forEach((btn) => {
    btn.addEventListener('click', () => removeKeyword(btn.dataset.removeKw, Number(btn.dataset.kwIndex)));
  });
}

function renderList() {
  const container = document.getElementById('groups');
  const emptyNote = document.getElementById('emptyNote');

  if (products.length === 0) {
    container.innerHTML = '';
    emptyNote.style.display = 'block';
    return;
  }
  emptyNote.style.display = 'none';

  const byGroup = new Map();
  const noGroup = [];

  products.forEach((p) => {
    if (!p.watch_group_id || !p.watch_groups?.name) { noGroup.push(p); return; }
    const key = normKey(p.watch_groups.name);
    const known = mergedGroups.find((g) => g.key === key);
    if (!byGroup.has(key)) byGroup.set(key, { label: known ? known.name : cleanText(p.watch_groups.name), items: [] });
    byGroup.get(key).items.push(p);
  });

  let html = '';
  for (const { label, items } of byGroup.values()) {
    html += renderGroupBlock(label, items);
  }
  if (noGroup.length) html += renderGroupBlock('Sem grupo', noGroup);

  container.innerHTML = html;

  container.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => removeProduct(btn.dataset.remove));
  });
}

function renderGroupBlock(name, items) {
  return `
    <div class="group-block">
      <div class="group-title">${escapeHtml(name)} <span class="group-count">(${items.length})</span></div>
      <div class="p-list">
        ${items.map(renderRow).join('')}
      </div>
    </div>
  `;
}

function renderRow(p) {
  const checked = p.last_checked_at
    ? new Date(p.last_checked_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : 'ainda não verificado';
  return `
    <div class="p-row">
      <img src="${p.image_url || ''}" alt="" loading="lazy" />
      <div class="p-title">${escapeHtml(p.title)}</div>
      <div class="p-checked">verificado em ${checked}</div>
      <a href="${p.permalink}" target="_blank" rel="noopener">Ver</a>
      <button class="remove" data-remove="${p.id}">Remover</button>
    </div>
  `;
}

async function addProduct() {
  const url = document.getElementById('urlInput').value.trim();
  const groupId = document.getElementById('groupSelect').value || null;
  const btn = document.getElementById('addBtn');
  const msg = document.getElementById('addMsg');

  if (!url) { msg.textContent = 'Cole um link primeiro.'; return; }

  btn.disabled = true;
  btn.textContent = 'Adicionando...';
  msg.textContent = '';

  try {
    const res = await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, watch_group_id: groupId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao adicionar');

    document.getElementById('urlInput').value = '';
    msg.textContent = 'Adicionado!';
    await load();
  } catch (err) {
    msg.textContent = `Erro: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Adicionar';
  }
}

async function removeProduct(id) {
  await fetch(`/api/watchlist?id=${id}`, { method: 'DELETE' });
  await load();
}

function renderManualFormOptions() {
  const mpSelect = document.getElementById('manual-marketplace');
  mpSelect.innerHTML = marketplaces.map((m) => `<option value="${m.slug}">${escapeHtml(m.name)}</option>`).join('');

  const groupSelect = document.getElementById('manual-group');
  groupSelect.innerHTML =
    `<option value="">Sem grupo</option>` +
    mergedGroups.map((g) => `<option value="${g.ids[0]}">${escapeHtml(g.name)}</option>`).join('');
}

async function submitManualPromotion() {
  const btn = document.getElementById('manualSubmitBtn');
  const msg = document.getElementById('manualMsg');

  const payload = {
    marketplace_slug: document.getElementById('manual-marketplace').value,
    watch_group_id: document.getElementById('manual-group').value || null,
    title: document.getElementById('manual-title').value.trim(),
    original_url: document.getElementById('manual-url').value.trim(),
    affiliate_url: document.getElementById('manual-affiliate').value.trim() || null,
    image_url: document.getElementById('manual-image').value.trim() || null,
    current_price: parseFloat(document.getElementById('manual-price').value.replace(',', '.')),
    previous_price: document.getElementById('manual-prev-price').value
      ? parseFloat(document.getElementById('manual-prev-price').value.replace(',', '.'))
      : null,
  };

  if (!payload.title || !payload.original_url || !payload.current_price) {
    msg.textContent = 'Preencha ao menos título, link original e preço atual.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Adicionando...';
  msg.textContent = '';

  try {
    const res = await fetch('/api/promotions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao adicionar');

    msg.textContent = 'Adicionada! Já aparece no Painel geral.';
    ['manual-title', 'manual-url', 'manual-affiliate', 'manual-image', 'manual-price', 'manual-prev-price']
      .forEach((id) => { document.getElementById(id).value = ''; });
  } catch (err) {
    msg.textContent = `Erro: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Adicionar ao painel';
  }
}

async function testSearch() {
  const keyword = document.getElementById('newGroupKeyword').value.trim();
  const btn = document.getElementById('testSearchBtn');
  const preview = document.getElementById('testPreview');
  const msg = document.getElementById('groupMsg');

  if (!keyword) { msg.textContent = 'Digite uma palavra-chave antes de testar.'; return; }

  btn.disabled = true;
  btn.textContent = 'Testando...';
  msg.textContent = '';
  preview.innerHTML = '';

  try {
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'test', keyword }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao testar');

    if (data.preview.length === 0) {
      msg.textContent = 'Nenhum resultado para essa palavra-chave — tente algo mais específico ou diferente.';
    } else {
      preview.innerHTML = data.preview.map((item) => `
        <div class="item">
          <img src="${item.image || ''}" alt="" loading="lazy" />
          <div>${escapeHtml(item.title)}</div>
          <div class="t-price">R$ ${Number(item.price).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</div>
        </div>
      `).join('');
      msg.textContent = 'Isso aqui bate com o que você quer? Se sim, clique em "Criar grupo".';
    }
  } catch (err) {
    msg.textContent = `Erro: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Testar busca';
  }
}

async function createGroup() {
  const name = document.getElementById('newGroupName').value.trim();
  const keyword = document.getElementById('newGroupKeyword').value.trim();
  const btn = document.getElementById('createGroupBtn');
  const msg = document.getElementById('groupMsg');

  if (!name || !keyword) { msg.textContent = 'Preencha o nome e a palavra-chave antes de criar.'; return; }

  btn.disabled = true;
  btn.textContent = 'Criando...';

  try {
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, search_keyword: keyword }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao criar');

    document.getElementById('newGroupName').value = '';
    document.getElementById('newGroupKeyword').value = '';
    document.getElementById('testPreview').innerHTML = '';
    msg.textContent = data.message || 'Grupo criado!';
    await load();
  } catch (err) {
    msg.textContent = `Erro: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Criar grupo';
  }
}

async function removeGroup(key) {
  const group = mergedGroups.find((g) => g.key === key);
  if (!group) return;
  if (!confirm(`Remover o grupo "${group.name}" (${group.keywords.length} palavra(s)-chave)? Produtos e promoções ligados a ele ficam "sem grupo", mas não são apagados.`)) return;
  const msg = document.getElementById('groupMsg');
  try {
    const res = await fetch(`/api/groups?id=${encodeURIComponent(group.ids.join(','))}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Falha ao remover');
  } catch (err) {
    msg.textContent = `Erro: ${err.message}`;
    return;
  }
  await load();
}

async function removeKeyword(key, index) {
  const group = mergedGroups.find((g) => g.key === key);
  const keyword = group && group.keywords[index];
  if (!keyword) return;
  const msg = document.getElementById('groupMsg');
  try {
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove_keyword', ids: group.ids, keyword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Falha ao remover a palavra-chave');
    msg.textContent = `Palavra-chave "${keyword}" removida de "${group.name}".`;
  } catch (err) {
    msg.textContent = `Erro: ${err.message}`;
    return;
  }
  await load();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

document.getElementById('addBtn').addEventListener('click', addProduct);
document.getElementById('testSearchBtn').addEventListener('click', testSearch);
document.getElementById('createGroupBtn').addEventListener('click', createGroup);
document.getElementById('manualSubmitBtn').addEventListener('click', submitManualPromotion);
load();
