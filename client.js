const API_BASE = 'https://api.mercadolibre.com';

/**
 * Busca pública de itens por categoria — NÃO exige autenticação.
 * Usada para a Trilha 2 (promoções de outros vendedores).
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
 * Troca o "code" do OAuth por access_token/refresh_token.
 * Doc: POST /oauth/token
 */
async function exchangeCodeForToken({ code, clientId, clientSecret, redirectUri }) {
  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
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
  exchangeCodeForToken,
  refreshAccessToken,
  authenticatedGet,
};
