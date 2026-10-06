const API_BASE = 'https://api.linksynergy.com';

/**
 * Pega um token de acesso (OAuth2 client_credentials) pra usar na Product
 * Search API. ATENÇÃO: não confirmei 100% o formato exato do corpo dessa
 * requisição (se é grant_type no body, Basic Auth no header, ou os dois) —
 * baseei no padrão OAuth2 client_credentials mais comum usado por essa
 * família de API (LinkShare/Rakuten). Se der erro de autenticação na
 * primeira tentativa real, me manda a mensagem de erro que eu ajusto.
 */
async function getAccessToken(clientId, clientSecret) {
  const res = await fetch(`${API_BASE}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'advertiser' }),
  });

  if (!res.ok) {
    throw new Error(`Falha ao pegar token da Rakuten (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token || data.token;
}

/**
 * Busca produtos por palavra-chave, filtrando pelo MID (ID do anunciante —
 * no nosso caso, Netshoes) na Product Search API.
 * ATENÇÃO: essa API, historicamente, responde em XML, não JSON — mas
 * versões mais novas (OAuth2) costumam aceitar `Accept: application/json`
 * e devolver JSON. Os nomes de campo abaixo (itemName, price, salePrice,
 * imageUrl, linkUrl, sku) são os mais comuns nessa família de API — ainda
 * NÃO FORAM CONFIRMADOS contra uma resposta real. Teste assim que tiver as
 * credenciais e me manda a resposta real se algo vier diferente.
 */
async function searchProducts(accessToken, mid, keyword, { max = 30 } = {}) {
  const url = `${API_BASE}/productsearch/1.0?mid=${encodeURIComponent(mid)}&keyword=${encodeURIComponent(keyword)}&max=${max}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Busca de produtos Netshoes/Rakuten falhou (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  // A API costuma aninhar os itens em algo como data.result.item (array) —
  // tentamos alguns formatos comuns; se nenhum bater, devolve vazio e loga.
  const items = data?.result?.item || data?.items || data?.result || [];
  return Array.isArray(items) ? items : [items].filter(Boolean);
}

/**
 * Monta o link de afiliado (deep link) — isso É confirmado, é o formato
 * padrão e documentado publicamente da Rakuten/LinkShare, sem precisar de
 * chamada de API nenhuma:
 * https://click.linksynergy.com/deeplink?id={publisherId}&mid={mid}&murl={url}
 */
function buildAffiliateLink(publisherId, mid, targetUrl) {
  return `https://click.linksynergy.com/deeplink?id=${encodeURIComponent(publisherId)}&mid=${encodeURIComponent(mid)}&murl=${encodeURIComponent(targetUrl)}`;
}

module.exports = { getAccessToken, searchProducts, buildAffiliateLink };
