const API_BASE = 'https://api.linksynergy.com';

/**
 * Login automático (client_credentials). Nos testes reais ele devolveu
 * "Invalid token" na Product Search API, então hoje é só um plano B — o
 * caminho principal é o Access Token gerado manualmente no painel da Rakuten
 * (Applications > Generate Token) e colado em /marketplaces.html.
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
  const token = data.access_token || data.token;
  if (!token) {
    throw new Error(`A Rakuten respondeu ao login automático sem nenhum token: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return token;
}

// ---------- Leitura de XML (a Product Search API só responde em XML) ----------

function decodeXml(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!match) return null;
  const inner = match[1].trim().replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
  return decodeXml(inner) || null;
}

function extractProductUrl(linkUrl) {
  if (!linkUrl) return null;
  try {
    // O linkurl vem como link rastreado da Rakuten; a página real do produto
    // está no parâmetro "murl".
    return new URL(linkUrl).searchParams.get('murl') || linkUrl;
  } catch {
    return linkUrl;
  }
}

/**
 * ATENÇÃO: os nomes das tags abaixo (item, productname, price, saleprice,
 * imageurl, linkurl, sku) seguem o formato XML conhecido da Product Search API
 * da Rakuten, mas AINDA NÃO FORAM CONFIRMADOS contra uma resposta real da sua
 * conta. Se a busca voltar sempre vazia, me mande um trecho da resposta real.
 */
function parseProductSearchXml(xml) {
  const errorId = xmlTag(xml, 'ErrorID');
  if (errorId) {
    const err = new Error(`Rakuten (erro ${errorId}): ${xmlTag(xml, 'ErrorText') || 'sem descrição'}`);
    err.code = errorId;
    throw err;
  }

  const blocks = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  return blocks.map((block) => {
    const linkUrl = xmlTag(block, 'linkurl');
    return {
      sku: xmlTag(block, 'sku'),
      itemName: xmlTag(block, 'productname'),
      price: xmlTag(block, 'price'),
      salePrice: xmlTag(block, 'saleprice'),
      imageUrl: xmlTag(block, 'imageurl'),
      linkUrl,
      productUrl: extractProductUrl(linkUrl),
    };
  });
}

async function fetchAndParse(url, accessToken) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/xml',
    },
  });
  const rawText = (await res.text()).trim();

  if (!rawText.startsWith('<')) {
    // Resposta em JSON = erro do portão OAuth (ex: "The access token is missing")
    throw new Error(`Rakuten respondeu (${res.status}): ${rawText.slice(0, 400)}`);
  }

  const items = parseProductSearchXml(rawText); // lança erro se vier <Errors>
  if (!res.ok) {
    throw new Error(`Rakuten respondeu com status ${res.status}: ${rawText.slice(0, 400)}`);
  }
  return items;
}

/**
 * Busca produtos por palavra-chave, filtrando pelo MID (Netshoes).
 * O token vai no cabeçalho Authorization: Bearer (é o que o portão OAuth da
 * Rakuten exige). Se a API responder "No token specified" (erro 718614),
 * tenta de novo mandando o token também na URL.
 */
async function searchProducts(accessToken, mid, keyword, { max = 30 } = {}) {
  const base = `${API_BASE}/productsearch/1.0?mid=${encodeURIComponent(mid)}&keyword=${encodeURIComponent(keyword)}&max=${max}`;
  try {
    return await fetchAndParse(base, accessToken);
  } catch (err) {
    if (err.code === '718614') {
      return fetchAndParse(`${base}&token=${encodeURIComponent(accessToken)}`, accessToken);
    }
    throw err;
  }
}

/**
 * Monta o link de afiliado (deep link) — confirmado em teste real:
 * https://click.linksynergy.com/deeplink?id={publisherId}&mid={mid}&murl={url}
 */
function buildAffiliateLink(publisherId, mid, targetUrl) {
  return `https://click.linksynergy.com/deeplink?id=${encodeURIComponent(publisherId)}&mid=${encodeURIComponent(mid)}&murl=${encodeURIComponent(targetUrl)}`;
}

module.exports = { getAccessToken, searchProducts, buildAffiliateLink, parseProductSearchXml };
