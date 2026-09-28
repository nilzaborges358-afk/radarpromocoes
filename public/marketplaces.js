const MARKETPLACES = [
  { slug: 'mercadolivre', name: 'Mercado Livre', color: '#fff159', implemented: true },
  { slug: 'shopee', name: 'Shopee', color: '#ee4d2d', implemented: false },
  { slug: 'amazon', name: 'Amazon', color: '#ff9900', implemented: false },
  { slug: 'magalu', name: 'Magalu', color: '#0086ff', implemented: false },
  { slug: 'tiktokshop', name: 'TikTok Shop', color: '#ffffff', implemented: false },
  { slug: 'netshoes', name: 'Netshoes', color: '#f5761a', implemented: false },
];

const list = document.getElementById('list');

function render() {
  list.innerHTML = MARKETPLACES.map((mp) => `
    <div class="mp-row" id="row-${mp.slug}">
      <div class="mp-head" onclick="toggleRow('${mp.slug}')">
        <div class="mp-name">
          <span class="dot ${mp.implemented ? 'off' : 'soon'}" id="dot-${mp.slug}"></span>
          ${mp.name}
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <span class="status-text" id="status-${mp.slug}">${mp.implemented ? 'carregando…' : 'em breve'}</span>
          <span class="chev">▾</span>
        </div>
      </div>
      <div class="mp-body" id="body-${mp.slug}">
        ${mp.implemented ? renderMercadoLivreForm() : `<p class="soon-note">Essa integração ainda não foi implementada. Assim que estiver pronta, o formulário de credenciais aparece aqui.</p>`}
      </div>
    </div>
  `).join('');

  loadMercadoLivreStatus();
}

function renderMercadoLivreForm() {
  return `
    <div class="field">
      <label>Client ID</label>
      <input type="text" id="ml-client-id" placeholder="Cole o Client ID do seu app" />
    </div>
    <div class="field">
      <label>Client Secret</label>
      <input type="password" id="ml-client-secret" placeholder="Cole o Client Secret do seu app" />
    </div>
    <div class="row-actions">
      <button class="primary" onclick="saveMlCredentials()">Salvar credenciais</button>
      <a class="primary" style="background:transparent; color:var(--accent); border:1px solid var(--accent);" href="/api/auth/mercadolivre/login" target="_blank">Conectar minha loja</a>
    </div>
    <div class="save-msg" id="ml-save-msg"></div>
  `;
}

function toggleRow(slug) {
  document.getElementById(`row-${slug}`).classList.toggle('open');
}

async function loadMercadoLivreStatus() {
  try {
    const res = await fetch('/api/credentials/mercadolivre');
    const data = await res.json();

    const dot = document.getElementById('dot-mercadolivre');
    const statusText = document.getElementById('status-mercadolivre');

    if (data.hasAccessToken) {
      dot.className = 'dot on';
      statusText.textContent = `Conectado${data.sellerId ? ` (seller ${data.sellerId})` : ''}`;
    } else if (data.hasCredentials) {
      dot.className = 'dot off';
      statusText.textContent = 'Credenciais salvas — falta conectar a loja';
    } else {
      dot.className = 'dot off';
      statusText.textContent = 'Não configurado';
    }

    if (data.clientId) {
      const input = document.getElementById('ml-client-id');
      if (input) input.value = data.clientId;
    }
  } catch (err) {
    document.getElementById('status-mercadolivre').textContent = 'Erro ao carregar status';
  }
}

async function saveMlCredentials() {
  const clientId = document.getElementById('ml-client-id').value.trim();
  const clientSecret = document.getElementById('ml-client-secret').value.trim();
  const msg = document.getElementById('ml-save-msg');

  if (!clientId || !clientSecret) {
    msg.textContent = 'Preencha os dois campos antes de salvar.';
    return;
  }

  msg.textContent = 'Salvando...';
  try {
    const res = await fetch('/api/credentials/mercadolivre', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao salvar');

    msg.textContent = 'Credenciais salvas. Agora clique em "Conectar minha loja".';
    await loadMercadoLivreStatus();
  } catch (err) {
    msg.textContent = `Erro: ${err.message}`;
  }
}

render();
