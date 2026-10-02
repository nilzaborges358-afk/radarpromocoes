let groups = [];
let products = [];

async function load() {
  try {
    const res = await fetch('/api/watchlist');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao carregar');
    groups = data.groups;
    products = data.products;
    renderGroupSelect();
    renderGroupsList();
    renderList();
  } catch (err) {
    document.getElementById('groups').innerHTML = `<p style="color:#e2604a; padding: 0 32px;">Erro ao carregar: ${err.message}</p>`;
  }
}

function renderGroupSelect() {
  const select = document.getElementById('groupSelect');
  select.innerHTML =
    `<option value="">Sem grupo</option>` +
    groups.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
}

function renderGroupsList() {
  const container = document.getElementById('groupsList');
  if (groups.length === 0) {
    container.innerHTML = `<p style="color:var(--muted); font-size:12px;">Nenhum grupo criado ainda.</p>`;
    return;
  }
  container.innerHTML = groups.map((g) => `
    <div class="group-row">
      <div>
        <div class="g-name">${escapeHtml(g.name)}</div>
        <div class="g-keyword">busca por: "${escapeHtml(g.search_keyword || g.name)}"</div>
      </div>
      <button class="remove" data-remove-group="${g.id}">Remover</button>
    </div>
  `).join('');

  container.querySelectorAll('[data-remove-group]').forEach((btn) => {
    btn.addEventListener('click', () => removeGroup(btn.dataset.removeGroup));
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
    const groupName = p.watch_groups?.name;
    if (!groupName) { noGroup.push(p); return; }
    if (!byGroup.has(groupName)) byGroup.set(groupName, []);
    byGroup.get(groupName).push(p);
  });

  let html = '';
  for (const [groupName, items] of byGroup.entries()) {
    html += renderGroupBlock(groupName, items);
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
    const res = await fetch('/api/groups/test-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword }),
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
    msg.textContent = 'Grupo criado!';
    await load();
  } catch (err) {
    msg.textContent = `Erro: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Criar grupo';
  }
}

async function removeGroup(id) {
  if (!confirm('Remover esse grupo? Produtos e promoções ligados a ele ficam "sem grupo", mas não são apagados.')) return;
  await fetch(`/api/groups?id=${id}`, { method: 'DELETE' });
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
load();
