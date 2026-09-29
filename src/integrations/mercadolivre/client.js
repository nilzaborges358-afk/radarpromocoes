const API_BASE = 'https://api.mercadolibre.com';

/**
 * Busca pública de itens por categoria — NÃO exige autenticação.
 * ATENÇÃO: o Mercado Livre passou a bloquear este endpoint (403 Forbidden)
 * para aplicações de terceiros a partir do final de 2025 — não é um bug
 * deste código. Mantido aqui só para o caso de um dia voltar a funcionar.
 * Doc: GET /sites/{site_id}/search?category={category_id}
 */
async function searchItemsByCategory({ siteId = 'MLB', categoryId, offset = 0, limit = 50 }) {
  const url = `${API_BASE}/sites/${siteId}/search?category=${categoryId}&offset=${offset}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Mercado Livre search falhou (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.results || [];
}

/**
 * Extrai o item_id (ex: MLB1234567890) a partir de um link de produto colado
 * pelo usuário. Os links do ML costumam trazer "MLB" seguido de dígitos em
 * algum ponto da URL (com ou sem hífen). Retorna null se não achar o padrão.
 */
function extractItemIdFromUrl(url) {
  const match = String(url).match(/MLB-?(\d{9,13})/i);
  return match ? `MLB${match[1]}` : null;
}

/**
 * Preço de venda atual do item — inclui o preço "de antes" (regular_amount)
 * e metadados de promoção quando existir uma rolando. Endpoint público e
 * documentado, ainda funcionando (diferente do /sites/{id}/search).
 * Doc: GET /items/{item_id}/sale_price
 */
async function getSalePrice(itemId, accessToken) {
  const res = await fetch(`${API_BASE}/items/${itemId}/sale_price?context=channel_marketplace`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
  if (!res.ok) {
    throw new Error(`sale_price falhou para ${itemId} (${res.status}): ${await res.text()}`);
  }
  return res.json(); // { amount, regular_amount, currency_id, metadata: { promotion_id, promotion_type } }
}

/**
 * Troca o "code" do OAuth por access_token/refresh_token.
 * Doc: POST /oauth/token
 */
async function exchangeCodeForToken({ code, clientId, clientSecret, redirectUri, codeVerifier }) {
  const body = {
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  };
  if (codeVerifier) body.code_verifier = codeVerifier;

  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body),
  });
  if (!res.ok) {
    throw new Error(`Falha ao trocar code por token (${res.status}): ${await res.text()}`);
  }
  return res.json(); // { access_token, refresh_token, expires_in, user_id, ... }
}

/** Renova o access_token usando o refresh_token salvo. */
async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`Falha ao renovar token (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/** Consulta autenticada genérica (usada pelo webhook para buscar o recurso notificado). */
async function authenticatedGet(path, accessToken) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Chamada autenticada falhou (${res.status}) em ${path}: ${await res.text()}`);
  }
  return res.json();
}

module.exports = {
  searchItemsByCategory,
  extractItemIdFromUrl,
  getSalePrice,
  exchangeCodeForToken,
  refreshAccessToken,
  authenticatedGet,
};
