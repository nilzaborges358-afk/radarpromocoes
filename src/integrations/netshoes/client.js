const API_BASE = 'https://api.linksynergy.com';

// Cada chamada à Rakuten tem prazo. Sem isso, uma chamada travada segurava a busca inteira
// até a Vercel cortar a função (e a tela ficava sem resposta nenhuma).
const REQUEST_TIMEOUT_MS = 8000;

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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`a Rakuten não respondeu em ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(`falha de rede: ${err.message}`);
  }
  const rawText = (await res.text()).trim();

  if (!rawText.startsWith('<')) {
    // Resposta em JSON = erro do portão OAuth (ex: "The access token is missing")
    throw new Error(`Rakuten respondeu (${res.status}): ${rawText.slice(0, 400)}`);
  }

  const items = parseProductSearchXml(rawText); // lança erro se vier <Errors>
  if (!res.ok) {
    throw new Error(`Rakuten respondeu com status ${res.status}: ${rawText.slice(0, 400)}`);
  }

  // Informações para diagnóstico (não atrapalham quem só usa a lista).
  items.totalMatches = Number(xmlTag(rawText, 'TotalMatches')) || 0;
  items.rawSample = items.length ? null : rawText.replace(/\s+/g, ' ').slice(0, 300);
  return items;
}

/**
 * Formas de falar com a Rakuten, da mais provável para a menos provável.
 * Na primeira busca o sistema testa uma por uma; a que funcionar fica "travada"
 * em `auth.strategy` e as próximas palavras-chave usam direto essa.
 */
const STRATEGIES = [
  {
    id: 'novo (OAuth + token)',
    ready: (a) => Boolean(a.accessToken),
    build: (a, q) => ({ url: `${API_BASE}/productsearch/1.0?${q}`, headers: { Authorization: `Bearer ${a.accessToken}`, Accept: 'application/xml' } }),
  },
  {
    id: 'novo (Web Services Token)',
    ready: (a) => Boolean(a.webServicesToken),
    build: (a, q) => ({ url: `${API_BASE}/productsearch/1.0?${q}`, headers: { Authorization: `Bearer ${a.webServicesToken}`, Accept: 'application/xml' } }),
  },
  {
    id: 'antigo',
    ready: (a) => Boolean(a.webServicesToken),
    build: (a, q) => ({ url: `http://productsearch.linksynergy.com/productsearch?${q}`, headers: { Accept: 'application/xml' } }),
  },
];

/**
 * Busca produtos por palavra-chave, filtrando pelo MID (Netshoes).
 *
 * `auth` = { accessToken, webServicesToken, strategy } — objeto compartilhado entre
 * todas as buscas de uma varredura (por isso a estratégia que funcionou fica guardada).
 *
 * São DOIS tokens diferentes (descoberto pelos erros reais da Rakuten):
 *  - accessToken: o token OAuth que o sistema gera sozinho (vale ~4h).
 *  - webServicesToken: o token fixo da página "APIs" (rodapé) do painel da Rakuten.
 */
// A busca da Rakuten trata alguns símbolos como comandos (ex: o hífen de "USB-C" dava
// INVALID_CONTEXT_VALUE). Troca por espaço e deixa só letras, números e acentos.
function sanitizeKeyword(keyword) {
  return String(keyword || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchProducts(auth, mid, rawKeyword, { max = 30 } = {}) {
  const keyword = sanitizeKeyword(rawKeyword) || String(rawKeyword || '').trim();
  const query = `token=${encodeURIComponent(auth.webServicesToken || '')}&mid=${encodeURIComponent(mid)}&keyword=${encodeURIComponent(keyword)}&max=${max}`;

  // Já sabemos qual forma funciona: usa só ela.
  if (auth.strategy) {
    const strategy = STRATEGIES.find((s) => s.id === auth.strategy);
    const req = strategy.build(auth, query);
    const items = await fetchAndParse(req.url, req.headers);
    items.strategy = strategy.id;
    return items;
  }

  const failures = [];
  for (const strategy of STRATEGIES) {
    if (!strategy.ready(auth)) continue;
    try {
      const req = strategy.build(auth, query);
      const items = await fetchAndParse(req.url, req.headers);
      auth.strategy = strategy.id;
      items.strategy = strategy.id;
      return items;
    } catch (err) {
      failures.push(`[${strategy.id}] ${err.message}`);
    }
  }
  throw new Error(failures.length ? failures.join(' | ') : 'nenhum token da Rakuten disponível para fazer a busca');
}

/**
 * Monta o link de afiliado (deep link) — confirmado em teste real:
 * https://click.linksynergy.com/deeplink?id={publisherId}&mid={mid}&murl={url}
 */
function buildAffiliateLink(publisherId, mid, targetUrl) {
  return `https://click.linksynergy.com/deeplink?id=${encodeURIComponent(publisherId)}&mid=${encodeURIComponent(mid)}&murl=${encodeURIComponent(targetUrl)}`;
}

module.exports = { getAccessToken, searchProducts, buildAffiliateLink, parseProductSearchXml, sanitizeKeyword };
