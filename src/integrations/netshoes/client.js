const API_BASE = 'https://api.linksynergy.com';

/**
 * Login automático (OAuth2 client_credentials) em api.linksynergy.com/token.
 * A Rakuten informa que esses tokens expiram em 4 horas, então não dá pra
 * depender de um token colado na mão: o sistema gera um novo quando precisa.
 *
 * `scope`: opcional. Aqui passamos o Publisher ID (SID), que é como a Rakuten
 * costuma amarrar o token à conta do publisher. Se a Rakuten recusar esse
 * escopo, a mensagem de erro dela aparece nos logs e eu ajusto.
 */
async function getAccessToken(clientId, clientSecret, scope) {
  const body = { grant_type: 'client_credentials' };
  if (scope) body.scope = String(scope);

  const res = await fetch(`${API_BASE}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams(body),
  });

  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(`Falha ao pegar token da Rakuten (${res.status}): ${rawText.slice(0, 400)}`);
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`Resposta inesperada ao pegar token da Rakuten: ${rawText.slice(0, 300)}`);
  }

  const token = data.access_token || data.token;
  if (!token) {
    throw new Error(`A Rakuten respondeu ao login automático sem nenhum token: ${rawText.slice(0, 300)}`);
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

async function fetchAndParse(url, headers) {
  const res = await fetch(url, { headers });
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
 *
 * São DOIS tokens diferentes (descoberto pelos erros reais da Rakuten):
 *  - accessToken: o token OAuth que o sistema gera sozinho (vale ~4h). Vai no
 *    cabeçalho Authorization: Bearer — o portão da Rakuten exige.
 *  - webServicesToken: o token fixo da página "Links > Web Services" do painel
 *    da Rakuten. Vai na URL (?token=) — é o que a API de produtos valida
 *    ("No token specified" / "Invalid token specified").
 *
 * Tenta primeiro o endereço novo (api.linksynergy.com) e, se falhar, o
 * endereço antigo da Product Search; se os dois falharem, o erro mostra os dois.
 */
async function searchProducts(accessToken, webServicesToken, mid, keyword, { max = 30 } = {}) {
  const query = `token=${encodeURIComponent(webServicesToken)}&mid=${encodeURIComponent(mid)}&keyword=${encodeURIComponent(keyword)}&max=${max}`;

  try {
    return await fetchAndParse(`${API_BASE}/productsearch/1.0?${query}`, {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/xml',
    });
  } catch (errNew) {
    try {
      return await fetchAndParse(`http://productsearch.linksynergy.com/productsearch?${query}`, {
        Accept: 'application/xml',
      });
    } catch (errOld) {
      throw new Error(`endereço novo: ${errNew.message} | endereço antigo: ${errOld.message}`);
    }
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
