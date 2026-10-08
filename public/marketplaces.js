const MARKETPLACES = [
  { slug: 'mercadolivre', name: 'Mercado Livre', color: '#fff159', implemented: true },
  { slug: 'shopee', name: 'Shopee', color: '#ee4d2d', implemented: true },
  { slug: 'amazon', name: 'Amazon', color: '#ff9900', implemented: true },
  { slug: 'magalu', name: 'Magalu', color: '#0086ff', implemented: true, manualOnly: true },
  { slug: 'tiktokshop', name: 'TikTok Shop', color: '#ffffff', implemented: false },
  { slug: 'netshoes', name: 'Netshoes', color: '#f5761a', implemented: true },
];

const list = document.getElementById('list');

function render() {
  list.innerHTML = MARKETPLACES.map((mp) => `
    <div class="mp-row" id="row-${mp.slug}">
      <div class="mp-head" onclick="toggleRow('${mp.slug}')">
        <div class="mp-name">
          <span class="dot ${mp.manualOnly ? 'soon' : mp.implemented ? 'off' : 'soon'}" id="dot-${mp.slug}"></span>
          ${mp.name}
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <span class="status-text" id="status-${mp.slug}">${mp.manualOnly ? 'sem API — cadastro manual' : mp.implemented ? 'carregando…' : 'em breve'}</span>
          <span class="chev">▾</span>
        </div>
      </div>
      <div class="mp-body" id="body-${mp.slug}">
        ${mp.manualOnly
          ? `<p class="soon-note">A ${mp.name} não tem API de afiliados — não existe como automatizar descoberta de promoção nem geração de link. Use o <a href="watchlist.html" style="color:var(--accent);">"Adicionar promoção manual"</a> na Lista de vigilância pra cadastrar o que você encontrar.</p>`
          : mp.implemented ? renderForm(mp.slug) : `<p class="soon-note">Essa integração ainda não foi implementada. Assim que estiver pronta, o formulário de credenciais aparece aqui.</p>`}
      </div>
    </div>
  `).join('');

  loadStatus('mercadolivre');
  loadStatus('shopee');
  loadStatus('amazon');
  loadStatus('netshoes');
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

  if (slug === 'netshoes') {
    return `
      <div class="field">
        <label>Publisher ID (Rakuten Advertising)</label>
        <input type="text" id="netshoes-tag" placeholder="Ex: seuID123" />
      </div>
      <div class="field">
        <label>MID da Netshoes (Advertiser ID)</label>
        <input type="text" id="netshoes-mid" placeholder="Ex: 42034" />
      </div>
      <div class="field">
        <label>Rakuten Client ID</label>
        <input type="text" id="netshoes-id" placeholder="Cole o Client ID" />
      </div>
      <div class="field">
        <label>Rakuten Client Secret</label>
        <input type="password" id="netshoes-secret" placeholder="Cole o Client Secret" />
      </div>
      <div class="field">
        <label>Access Token (botão "Generate Token" na tela Applications da Rakuten)</label>
        <input type="password" id="netshoes-token" placeholder="Cole o token gerado — deixe vazio pra manter o que já está salvo" />
      </div>
      <div class="row-actions">
        <button class="primary" onclick="saveCredentials('netshoes')">Salvar credenciais</button>
      </div>
      <div class="save-msg" id="netshoes-save-msg"></div>
      <p class="soon-note" style="margin-top:10px;">O Publisher ID e o MID você encontra no seu painel da Rakuten Advertising, depois de aprovado no programa "Parceiro Netshoes".</p>
    `;
  }

  if (slug === 'amazon') {
    return `
      <div class="field">
        <label>Associate Tag (do programa Associados)</label>
        <input type="text" id="amazon-tag" placeholder="Ex: seunome-20" />
      </div>
      <div class="field">
        <label>Creators API Access Key</label>
        <input type="text" id="amazon-id" placeholder="Cole a Access Key" />
      </div>
      <div class="field">
        <label>Creators API Secret Key</label>
        <input type="password" id="amazon-secret" placeholder="Cole a Secret Key" />
      </div>
      <div class="row-actions">
        <button class="primary" onclick="saveCredentials('amazon')">Salvar credenciais</button>
      </div>
      <div class="save-msg" id="amazon-save-msg"></div>
      <p class="soon-note" style="margin-top:10px; color:var(--accent);">
        ⚠️ A Amazon só libera a busca de produtos depois que sua conta tiver 10 vendas qualificadas
        nos últimos 30 dias como Associado. Pode salvar as credenciais desde já — a busca fica
        "esperando" até o requisito ser atingido.
      </p>
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
      if (slug === 'shopee' || slug === 'netshoes') {
        dot.className = 'dot on';
        statusText.textContent = 'Credenciais salvas';
      } else if (slug === 'amazon') {
        dot.className = 'dot off';
        statusText.textContent = 'Credenciais salvas — aguardando requisito de vendas';
      } else {
        dot.className = 'dot off';
        statusText.textContent = 'Credenciais salvas — falta conectar a loja';
      }
    } else {
      dot.className = 'dot off';
      statusText.textContent = 'Não configurado';
    }

    if (data.clientId) {
      const input = document.getElementById(`${slug}-id`);
      if (input) input.value = data.clientId;
    }
    if (data.extraCredential) {
      const tagInput = document.getElementById(`${slug}-tag`);
      if (tagInput) tagInput.value = data.extraCredential;
    }
    if (data.extraCredential2) {
      const midInput = document.getElementById(`${slug}-mid`);
      if (midInput) midInput.value = data.extraCredential2;
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
    let body;
    if (slug === 'shopee') {
      body = { app_id: id, app_secret: secret };
    } else if (slug === 'amazon') {
      body = {
        access_key: id,
        secret_key: secret,
        associate_tag: document.getElementById('amazon-tag').value.trim(),
      };
    } else if (slug === 'netshoes') {
      body = {
        rakuten_client_id: id,
        rakuten_client_secret: secret,
        publisher_id: document.getElementById('netshoes-tag').value.trim(),
        mid: document.getElementById('netshoes-mid').value.trim(),
        access_token: document.getElementById('netshoes-token').value.trim(),
      };
    } else {
      body = { client_id: id, client_secret: secret };
    }

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
