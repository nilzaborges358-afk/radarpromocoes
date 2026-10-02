const MARKETPLACES = [
  { slug: 'mercadolivre', name: 'Mercado Livre', color: '#fff159', implemented: true },
  { slug: 'shopee', name: 'Shopee', color: '#ee4d2d', implemented: true },
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
        ${mp.implemented ? renderForm(mp.slug) : `<p class="soon-note">Essa integração ainda não foi implementada. Assim que estiver pronta, o formulário de credenciais aparece aqui.</p>`}
      </div>
    </div>
  `).join('');

  loadStatus('mercadolivre');
  loadStatus('shopee');
}

function renderForm(slug) {
  if (slug === 'mercadolivre') {
    return `
      <div class="field">
        <label>Client ID</label>
        <input type="text" id="mercadolivre-id" placeholder="Cole o Client ID do seu app" />
      </div>
      <div class="field">
        <label>Client Secret</label>
        <input type="password" id="mercadolivre-secret" placeholder="Cole o Client Secret do seu app" />
      </div>
      <div class="row-actions">
        <button class="primary" onclick="saveCredentials('mercadolivre')">Salvar credenciais</button>
        <a class="primary" style="background:transparent; color:var(--accent); border:1px solid var(--accent);" href="/api/auth/mercadolivre" target="_blank">Conectar minha loja</a>
      </div>
      <div class="save-msg" id="mercadolivre-save-msg"></div>
      <p class="soon-note" style="margin-top:10px;">Só usado para a sua própria loja (webhook). A busca de promoções de terceiros no Mercado Livre está bloqueada pela plataforma — veja a tela de Vigilância para o que ainda funciona.</p>
    `;
  }

  if (slug === 'shopee') {
    return `
      <div class="field">
        <label>App ID</label>
        <input type="text" id="shopee-id" placeholder="Cole o App ID (affiliate.shopee.com.br)" />
      </div>
      <div class="field">
        <label>App Secret</label>
        <input type="password" id="shopee-secret" placeholder="Cole o App Secret" />
      </div>
      <div class="row-actions">
        <button class="primary" onclick="saveCredentials('shopee')">Salvar credenciais</button>
      </div>
      <div class="save-msg" id="shopee-save-msg"></div>
      <p class="soon-note" style="margin-top:10px;">Não precisa de "conectar" — assim que salvar, o botão "Buscar promoções agora" do painel geral já passa a buscar na Shopee também, usando os grupos da Lista de vigilância como palavra-chave.</p>
    `;
  }

  return '';
}

function toggleRow(slug) {
  document.getElementById(`row-${slug}`).classList.toggle('open');
}

async function loadStatus(slug) {
  try {
    const res = await fetch(`/api/credentials/${slug}`);
    const data = await res.json();

    const dot = document.getElementById(`dot-${slug}`);
    const statusText = document.getElementById(`status-${slug}`);

    if (data.hasAccessToken) {
      dot.className = 'dot on';
      statusText.textContent = `Conectado${data.sellerId ? ` (seller ${data.sellerId})` : ''}`;
    } else if (data.hasCredentials) {
      dot.className = slug === 'shopee' ? 'dot on' : 'dot off';
      statusText.textContent = slug === 'shopee' ? 'Credenciais salvas' : 'Credenciais salvas — falta conectar a loja';
    } else {
      dot.className = 'dot off';
      statusText.textContent = 'Não configurado';
    }

    if (data.clientId) {
      const input = document.getElementById(`${slug}-id`);
      if (input) input.value = data.clientId;
    }
  } catch (err) {
    const statusText = document.getElementById(`status-${slug}`);
    if (statusText) statusText.textContent = 'Erro ao carregar status';
  }
}

async function saveCredentials(slug) {
  const id = document.getElementById(`${slug}-id`).value.trim();
  const secret = document.getElementById(`${slug}-secret`).value.trim();
  const msg = document.getElementById(`${slug}-save-msg`);

  if (!id || !secret) {
    msg.textContent = 'Preencha os dois campos antes de salvar.';
    return;
  }

  msg.textContent = 'Salvando...';
  try {
    const body = slug === 'shopee'
      ? { app_id: id, app_secret: secret }
      : { client_id: id, client_secret: secret };

    const res = await fetch(`/api/credentials/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao salvar');

    msg.textContent = slug === 'mercadolivre'
      ? 'Credenciais salvas. Agora clique em "Conectar minha loja".'
      : 'Credenciais salvas!';
    await loadStatus(slug);
  } catch (err) {
    msg.textContent = `Erro: ${err.message}`;
  }
}

render();
