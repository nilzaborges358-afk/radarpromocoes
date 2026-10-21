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

/**
 * Consulta pública, sem token — usada para itens de OUTROS vendedores.
 * O token da sua loja só tem permissão sobre os seus próprios itens; para
 * produtos de terceiros (como os da lista de vigilância), a leitura pública
 * funciona melhor do que a autenticada.
 */
async function publicGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`Chamada pública falhou (${res.status}) em ${path}: ${await res.text()}`);
  }
  return res.json();
}

// =====================================================================
// Leitura de produtos de OUTROS vendedores (lista de vigilância)
// =====================================================================
//
// Por que existe: o scan do Mercado Livre chamava /items/{id}/sale_price SEM token. A doc oficial
// mostra "Authorization: Bearer" em todas as chamadas, e sem token o ML responde 403
// (PA_UNAUTHORIZED_RESULT_FROM_POLICIES). Aqui a ordem passa a ser:
//   1) API com o token da sua conta  2) API sem token  3) leitura da página pública do produto.
// Cada resultado informa por qual caminho veio (`source`), para o painel mostrar o que funcionou.

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** GET na API do ML devolvendo JSON; em erro, lança Error com .status e o código do ML. */
async function mlJson(path, accessToken) {
  const headers = { Accept: 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${API_BASE}${path}`, { headers, signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* resposta não-JSON */ }
  if (!res.ok) {
    const code = body && (body.code || body.error || body.message);
    const err = new Error(`HTTP ${res.status}${code ? ` ${String(code).slice(0, 60)}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/** Tenta com token e, se falhar, sem token. Devolve { data, via } ou lança com o resumo das duas tentativas. */
async function mlGetAny(path, accessToken) {
  const problems = [];
  if (accessToken) {
    try { return { data: await mlJson(path, accessToken), via: 'api_token' }; }
    catch (err) { problems.push(`com token ${err.message}`); }
  } else {
    problems.push('sem token da conta salvo');
  }
  try { return { data: await mlJson(path, null), via: 'api_public' }; }
  catch (err) {
    problems.push(`sem token ${err.message}`);
    const e = new Error(`${path.split('?')[0]}: ${problems.join(' / ')}`);
    e.status = err.status;
    throw e;
  }
}

/** Links curtos (meli.la, mercadolivre.com/sec/...) viram o link final do produto. */
async function resolveShortUrl(url) {
  try {
    const host = new URL(url).hostname;
    const isShort =
      /(^|\.)meli\.la$/i.test(host) || (/mercadoli[vb]re\.com(\.br)?$/i.test(host) && /\/sec\//.test(url));
    if (!isShort) return url;
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
      signal: AbortSignal.timeout(7000),
    });
    return res.url || url;
  } catch {
    return url;
  }
}

/**
 * Descobre o que o link aponta:
 *  - item     -> anúncio (MLB + 9 a 13 dígitos), ex.: /MLB-3295112047-titulo-_JM  ou  ?wid=MLB3295112047
 *  - catalog  -> página de catálogo (/p/MLB + 6 a 13 dígitos). Antes esses links eram rejeitados,
 *                porque o código do catálogo costuma ter só 8 dígitos.
 *  - up       -> página de "User Product" (/up/MLBU...), que só dá para ler pela página.
 */
function parseMlLink(url) {
  const s = String(url || '');
  const wid = s.match(/[?&#]wid=(MLB-?\d{6,13})/i);
  if (wid) return { id: wid[1].replace('-', '').toUpperCase(), kind: 'item' };
  const catalog = s.match(/\/p\/(MLB-?\d{6,13})/i);
  if (catalog) return { id: catalog[1].replace('-', '').toUpperCase(), kind: 'catalog' };
  const up = s.match(/\/up\/(MLBU\d{4,})/i);
  if (up) return { id: up[1].toUpperCase(), kind: 'up' };
  const item = extractItemIdFromUrl(s);
  return item ? { id: item, kind: 'item' } : null;
}

/** Primeiro link de produto dentro do HTML (catálogo /p/MLB..., depois ?wid=, depois anúncio MLB-123...). */
function parseMlFromHtml(html) {
  const s = String(html || '');
  const catalog = s.match(/\/p\/(MLB\d{6,13})/i);
  if (catalog) return { id: catalog[1].toUpperCase(), kind: 'catalog' };
  const wid = s.match(/[?&;]wid=(MLB-?\d{6,13})/i);
  if (wid) return { id: wid[1].replace('-', '').toUpperCase(), kind: 'item' };
  const item = s.match(/MLB-?(\d{9,13})/i);
  return item ? { id: `MLB${item[1]}`, kind: 'item' } : null;
}

/**
 * Abre qualquer link colado (inclusive meli.la) e descobre o produto.
 * Link curto de divulgador (meli.la) leva a mercadolivre.com.br/social/<perfil>?..., que NÃO tem o MLB
 * na URL: o produto divulgado é o 1º link de produto do HTML dessa página.
 * Devolve { url, parsed, note } — parsed é null quando não deu para identificar (note explica).
 */
async function resolveMlUrl(rawUrl) {
  const input = String(rawUrl || '').trim();
  let parsed = parseMlLink(input);
  if (parsed) return { url: input, parsed, note: null };

  let host = '';
  try { host = new URL(input).hostname; } catch { return { url: input, parsed: null, note: 'o texto colado não é um link' }; }
  const isMl = /(^|\.)meli\.la$/i.test(host) || /mercadoli[vb]re\./i.test(host);
  if (!isMl) return { url: input, parsed: null, note: 'o link não é do Mercado Livre' };

  try {
    const res = await fetch(input, {
      redirect: 'follow',
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
      signal: AbortSignal.timeout(9000),
    });
    const finalUrl = res.url || input;
    parsed = parseMlLink(finalUrl);
    if (parsed) return { url: finalUrl, parsed, note: null };
    if (!res.ok) return { url: finalUrl, parsed: null, note: `o Mercado Livre respondeu HTTP ${res.status} ao abrir o link (bloqueia leitura vinda de servidor)` };
    parsed = parseMlFromHtml(await res.text());
    if (parsed) {
      const url = parsed.kind === 'catalog' ? `https://www.mercadolivre.com.br/p/${parsed.id}` : finalUrl;
      return { url, parsed, note: null };
    }
    return { url: finalUrl, parsed: null, note: 'abri o link mas não achei nenhum produto na página' };
  } catch (err) {
    return { url: input, parsed: null, note: `não consegui abrir o link (${err.message})` };
  }
}

/** Para produtos já salvos: o permalink de catálogo (/p/MLB...) indica que o código salvo é de catálogo. */
function kindFromStored(sourceItemId, permalink) {
  if (/\/up\/MLBU/i.test(String(permalink || '')) || /^MLBU/i.test(String(sourceItemId || ''))) return 'up';
  if (/\/p\/MLB/i.test(String(permalink || '')) && !/^MLB\d{9,13}$/i.test(String(sourceItemId || ''))) return 'catalog';
  return 'item';
}

/**
 * Token da conta do ML guardado no Supabase, renovado quando vence.
 * Devolve { token, reason }. Quando token é null, `reason` explica o motivo (aparece no relatório).
 * O refresh_token do ML é de uso único: o novo é sempre gravado de volta.
 */
async function getAccessToken(supabase) {
  const { data: mp } = await supabase.from('marketplaces').select('id').eq('slug', 'mercadolivre').maybeSingle();
  if (!mp) return { token: null, reason: 'marketplace mercadolivre não existe no banco' };
  const { data: creds } = await supabase
    .from('marketplace_credentials')
    .select('client_id, client_secret, access_token, refresh_token, token_expires_at')
    .eq('marketplace_id', mp.id)
    .maybeSingle();
  if (!creds || !creds.access_token) {
    return { token: null, reason: 'a conta do ML ainda não foi conectada (abra /api/auth/mercadolivre e autorize)' };
  }
  const expired = creds.token_expires_at && new Date(creds.token_expires_at).getTime() < Date.now() + 60000;
  if (!expired) return { token: creds.access_token, reason: null };
  if (!creds.refresh_token || !creds.client_id || !creds.client_secret) {
    return { token: null, reason: 'o token venceu e não há refresh_token salvo (reconecte em /api/auth/mercadolivre)' };
  }
  try {
    const t = await refreshAccessToken({
      clientId: creds.client_id,
      clientSecret: creds.client_secret,
      refreshToken: creds.refresh_token,
    });
    await supabase
      .from('marketplace_credentials')
      .update({
        access_token: t.access_token,
        refresh_token: t.refresh_token || creds.refresh_token,
        token_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('marketplace_id', mp.id);
    return { token: t.access_token, reason: null };
  } catch (err) {
    return { token: null, reason: `não consegui renovar o token (${String(err.message).slice(0, 160)}) — reconecte em /api/auth/mercadolivre` };
  }
}

/** Plano C: lê título/preço/imagem da página pública do produto (pode ser bloqueado em IP de datacenter). */
async function fetchPageSnapshot(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`página do produto respondeu HTTP ${res.status}`);
  const html = await res.text();

  let title = null; let price = null; let image = null;
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1]);
      const nodes = Array.isArray(parsed) ? parsed : [parsed, ...(parsed['@graph'] || [])];
      const prod = nodes.find((n) => n && String(n['@type']).toLowerCase() === 'product');
      if (!prod) continue;
      title = prod.name || title;
      image = (Array.isArray(prod.image) ? prod.image[0] : prod.image) || image;
      const offer = Array.isArray(prod.offers) ? prod.offers[0] : prod.offers;
      if (offer) price = toNumber(offer.price || offer.lowPrice) || price;
      break;
    } catch { /* tenta o próximo bloco */ }
  }
  if (!title) { const t = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i); if (t) title = t[1]; }
  if (!image) { const i = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i); if (i) image = i[1]; }
  if (!price) { const pm = html.match(/"price"\s*:\s*"?(\d+(?:\.\d+)?)"?/); if (pm) price = toNumber(pm[1]); }
  if (!price) throw new Error('não consegui ler o preço na página do produto');
  return { title: title || 'Produto do Mercado Livre', price, image };
}

/**
 * Foto atual de um produto: preço de venda, preço "de antes" e metadados da promoção.
 * Retorna { source, itemId, title, price, regularPrice, promotionId, promotionType, thumbnail, permalink, sellerNickname }.
 * Lança Error (com .problems e .statuses) só quando TODOS os caminhos falharam.
 *  - needDetails: também busca /items/{id} (título, imagem, link) — usado ao ADICIONAR o produto.
 */
async function getItemSnapshot({ id, kind = 'item', token, url, needDetails = false }) {
  const problems = [];
  const statuses = [];
  const note = (err) => { problems.push(err.message); if (err.status) statuses.push(err.status); };

  let itemId = kind === 'item' ? id : null;
  let buyBox = null;

  if (kind === 'catalog') {
    try {
      const { data } = await mlGetAny(`/products/${id}`, token);
      buyBox = data && data.buy_box_winner ? data.buy_box_winner : null;
      itemId = buyBox && buyBox.item_id ? String(buyBox.item_id) : null;
      if (!itemId) problems.push(`/products/${id}: sem anúncio vencedor (buy_box_winner) no momento`);

      // Anúncios de OUTROS vendedores costumam ser bloqueados em /items (403); a página de catálogo
      // (/products/{id}) já traz o preço do anúncio vencedor — usa ele direto, sem passar por /items.
      const bbSale = buyBox && buyBox.sale_price && typeof buyBox.sale_price === 'object' ? buyBox.sale_price : null;
      const bbPrice = toNumber(bbSale && bbSale.amount) ?? toNumber(buyBox && buyBox.price);
      if (bbPrice) {
        const bbRegular = toNumber(bbSale && bbSale.regular_amount) ?? toNumber(buyBox && buyBox.original_price);
        const pic = Array.isArray(data.pictures) && data.pictures[0] ? data.pictures[0].url || data.pictures[0].secure_url : null;
        return {
          source: 'api_catalog',
          itemId,
          title: data.name || data.title || null,
          price: bbPrice,
          regularPrice: bbRegular && bbRegular > bbPrice ? bbRegular : null,
          promotionId: null,
          promotionType: null,
          thumbnail: pic ? String(pic).replace(/^http:/, 'https:') : null,
          permalink: `https://www.mercadolivre.com.br/p/${id}`,
          sellerNickname: null,
        };
      }
    } catch (err) { note(err); }
  }

  if (itemId) {
    let sale = null; let item = null; let via = null;
    try {
      const r = await mlGetAny(`/items/${itemId}/sale_price?context=channel_marketplace`, token);
      sale = r.data; via = r.via;
    } catch (err) { note(err); }

    if (needDetails || !sale) {
      try {
        const r = await mlGetAny(`/items/${itemId}`, token);
        item = r.data; via = via || r.via;
      } catch (err) { note(err); }
    }

    const price = toNumber(sale && sale.amount) ?? toNumber(item && item.price) ?? toNumber(buyBox && buyBox.price);
    if (price) {
      const regular =
        toNumber(sale && sale.regular_amount) ?? toNumber(item && item.original_price) ?? toNumber(buyBox && buyBox.original_price);
      const meta = (sale && sale.metadata) || {};
      return {
        source: via || 'api_token',
        itemId,
        title: item ? item.title : null,
        price,
        regularPrice: regular && regular > price ? regular : null,
        promotionId: meta.promotion_id || null,
        promotionType: meta.promotion_type || null,
        thumbnail: item && item.thumbnail ? String(item.thumbnail).replace(/^http:/, 'https:') : null,
        permalink: item ? item.permalink : null,
        sellerNickname: item && item.seller ? item.seller.nickname || null : null,
      };
    }
  }

  if (url) {
    try {
      const page = await fetchPageSnapshot(url);
      return {
        source: 'page',
        itemId,
        title: page.title,
        price: page.price,
        regularPrice: null,
        promotionId: null,
        promotionType: null,
        thumbnail: page.image ? String(page.image).replace(/^http:/, 'https:') : null,
        permalink: url,
        sellerNickname: null,
      };
    } catch (err) { problems.push(`leitura da página: ${err.message}`); }
  }

  const err = new Error(problems.join(' | ') || 'nenhum caminho de leitura funcionou');
  err.problems = problems;
  err.statuses = statuses;
  throw err;
}

/**
 * Descoberta por palavra-chave (substituto do /sites/MLB/search, que o ML bloqueia): busca produtos de
 * CATÁLOGO ativos. Devolve [{ id, title }]. Endpoint documentado: GET /products/search?status=active&site_id=MLB&q=...
 */
async function searchCatalogProducts({ q, token, limit = 10, offset = 0, siteId = 'MLB' }) {
  const path = `/products/search?status=active&site_id=${siteId}&q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`;
  const { data } = await mlGetAny(path, token);
  const list = (data && (data.results || data.products)) || [];
  return list.filter((r) => r && r.id).map((r) => ({ id: String(r.id).toUpperCase(), title: r.name || r.title || null }));
}

module.exports = {
  searchItemsByCategory,
  extractItemIdFromUrl,
  getSalePrice,
  exchangeCodeForToken,
  refreshAccessToken,
  authenticatedGet,
  publicGet,
  // novos
  resolveShortUrl,
  resolveMlUrl,
  parseMlFromHtml,
  searchCatalogProducts,
  parseMlLink,
  kindFromStored,
  getAccessToken,
  getItemSnapshot,
};
