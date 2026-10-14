const ml = require('../integrations/mercadolivre/client');
const netshoesClient = require('../integrations/netshoes/client');

// ---------- utilidades ----------

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  let s = String(value).trim();
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function listFrom(value) {
  return String(value || '').split(',').map((v) => v.trim().toUpperCase()).filter(Boolean);
}

function todayBR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // AAAA-MM-DD
}

function money(v) {
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function detectMarketplace(url) {
  const u = String(url || '').toLowerCase();
  if (/mercadolivre|mercadolibre|meli\.la/.test(u)) return 'mercadolivre';
  if (/shopee/.test(u)) return 'shopee';
  if (/netshoes/.test(u)) return 'netshoes';
  if (/amazon\.com|amzn\./.test(u)) return 'amazon';
  if (/magazineluiza|magalu/.test(u)) return 'magalu';
  return null;
}

// ---------- Mercado Livre: dados reais do produto ----------

async function resolveShortUrl(url) {
  try {
    const host = new URL(url).hostname;
    const isShort = /(^|\.)meli\.la$/i.test(host) || (/mercadolivre\.com(\.br)?$/i.test(host) && /\/sec\//.test(url));
    if (!isShort) return url;
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(6000) });
    return res.url || url;
  } catch {
    return url;
  }
}

function pickMlId(url) {
  // Em links de catálogo (/p/MLB...) o anúncio real vem no parâmetro wid=
  const wid = String(url).match(/[?&#]wid=(MLB-?\d{6,13})/i);
  if (wid) return { id: wid[1].replace('-', '').toUpperCase(), catalog: false };
  const catalog = String(url).match(/\/p\/(MLB\d{6,13})/i);
  const id = ml.extractItemIdFromUrl(url);
  return { id: id || (catalog ? catalog[1].toUpperCase() : null), catalog: Boolean(catalog) };
}

async function mlGet(path, token) {
  const problems = [];
  if (token) {
    try { return await ml.authenticatedGet(path, token); } catch (err) { problems.push(`com token: ${err.message.slice(0, 140)}`); }
  } else {
    problems.push('sem token da sua conta salvo');
  }
  try { return await ml.publicGet(path); } catch (err) { problems.push(`sem token: ${err.message.slice(0, 140)}`); }
  throw new Error(problems.join(' | '));
}

// Token da sua conta do ML, renovado automaticamente quando vencido.
async function getMlToken(supabase) {
  const { data: mp } = await supabase.from('marketplaces').select('id').eq('slug', 'mercadolivre').maybeSingle();
  if (!mp) return null;
  const { data: creds } = await supabase
    .from('marketplace_credentials')
    .select('client_id, client_secret, access_token, refresh_token, token_expires_at')
    .eq('marketplace_id', mp.id)
    .maybeSingle();
  if (!creds || !creds.access_token) return null;

  const expired = creds.token_expires_at && new Date(creds.token_expires_at).getTime() < Date.now() + 60000;
  if (!expired) return creds.access_token;
  if (!creds.refresh_token || !creds.client_id || !creds.client_secret) return null;
  try {
    const t = await ml.refreshAccessToken({ clientId: creds.client_id, clientSecret: creds.client_secret, refreshToken: creds.refresh_token });
    await supabase.from('marketplace_credentials').update({
      access_token: t.access_token,
      refresh_token: t.refresh_token || creds.refresh_token,
      token_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
    }).eq('marketplace_id', mp.id);
    return t.access_token;
  } catch {
    return null; // precisa reconectar a conta em /api/auth/mercadolivre
  }
}

// Plano B: o ML bloqueia a API para itens de outros vendedores (403 PolicyAgent).
// Lê o que a própria página pública do produto mostra (título, preço, imagem e,
// quando aparecem no código da página, categoria e vendedor).
async function fetchMlFromPage(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`a página do produto respondeu ${res.status}`);
  const html = await res.text();

  let title = null; let price = null; let image = null; let originalPrice = null;
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1]);
      const nodes = Array.isArray(parsed) ? parsed : [parsed, ...(parsed['@graph'] || [])];
      const prod = nodes.find((n) => n && String(n['@type']).toLowerCase() === 'product');
      if (!prod) continue;
      title = prod.name || title;
      image = (Array.isArray(prod.image) ? prod.image[0] : prod.image) || image;
      const offer = Array.isArray(prod.offers) ? prod.offers[0] : prod.offers;
      if (offer) price = num(offer.price || offer.lowPrice) || price;
      break;
    } catch { /* tenta o próximo bloco */ }
  }
  if (!title) { const t = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i); if (t) title = t[1]; }
  if (!image) { const i = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i); if (i) image = i[1]; }
  if (!price) { const pm = html.match(/"price"\s*:\s*"?(\d+(?:\.\d+)?)"?/); if (pm) price = num(pm[1]); }
  if (!price) throw new Error('não consegui ler o preço na página do produto');

  const cat = html.match(/"category_id"\s*:\s*"(MLB\d+)"/i);
  const seller = html.match(/"seller_id"\s*:\s*"?(\d{4,})"?/i);
  return { title: title || 'Produto do Mercado Livre', price, originalPrice, image, categoryId: cat ? cat[1].toUpperCase() : null, sellerId: seller ? seller[1] : null };
}

async function categoryPathFor(categoryId, token) {
  let path = categoryId ? [String(categoryId).toUpperCase()] : [];
  if (categoryId) {
    try {
      const cat = await mlGet(`/categories/${categoryId}`, token);
      const full = (cat.path_from_root || []).map((c) => String(c.id).toUpperCase());
      if (full.length) path = full;
    } catch { /* fica só com a categoria do item */ }
  }
  return path;
}

async function fetchMercadoLivreItem(rawUrl, token) {
  const url = await resolveShortUrl(rawUrl);
  const { id, catalog } = pickMlId(url);
  if (!id) {
    throw new Error('Não achei o código do produto (MLB...) nesse link. Cole o link completo da página do produto (links curtos como meli.la às vezes não abrem).');
  }

  let item;
  let apiError = null;
  try {
    item = await mlGet(`/items/${id}`, token);
  } catch (err) {
    apiError = err.message;
    if (catalog) {
      try {
        const product = await mlGet(`/products/${id}`, token);
        const winner = product && product.buy_box_winner && product.buy_box_winner.item_id;
        if (winner) { item = await mlGet(`/items/${winner}`, token); apiError = null; }
      } catch { /* cai no plano B */ }
    }
  }

  if (!item) {
    // Plano B: ler a página pública do produto
    try {
      const page = await fetchMlFromPage(url);
      return {
        marketplace: 'mercadolivre',
        source: 'page',
        id,
        title: page.title,
        price: page.price,
        originalPrice: null,
        promotionType: null,
        thumbnail: page.image ? String(page.image).replace(/^http:/, 'https:') : null,
        permalink: url,
        categoryPath: await categoryPathFor(page.categoryId, token),
        sellerId: page.sellerId,
      };
    } catch (pageErr) {
      throw new Error(`a API do Mercado Livre bloqueou a leitura (${apiError}) e a leitura da página também falhou (${pageErr.message}).`);
    }
  }

  // Preço realmente cobrado agora (já com promoção do próprio ML, se houver)
  let price = num(item.price);
  let originalPrice = num(item.original_price);
  let promotionType = null;
  try {
    const sale = await ml.getSalePrice(item.id, token);
    if (num(sale.amount)) price = num(sale.amount);
    if (num(sale.regular_amount)) originalPrice = num(sale.regular_amount);
    promotionType = sale.metadata && sale.metadata.promotion_type ? sale.metadata.promotion_type : null;
  } catch { /* segue com o preço do anúncio */ }

  return {
    marketplace: 'mercadolivre',
    source: 'api',
    id: item.id,
    title: item.title,
    price,
    originalPrice: originalPrice && originalPrice > price ? originalPrice : null,
    promotionType,
    thumbnail: item.thumbnail ? String(item.thumbnail).replace(/^http:/, 'https:') : null,
    permalink: item.permalink || url,
    categoryPath: await categoryPathFor(item.category_id, token),
    sellerId: item.seller_id ? String(item.seller_id) : null,
  };
}

// ---------- cruzamento: quais cupons valem para este produto ----------

function matchCoupons(coupons, ctx) {
  const today = todayBR();
  const applicable = [];
  const excluded = [];

  for (const c of coupons) {
    const reasons = [];
    const warnings = [];
    if (!c.active) reasons.push('cupom desativado');
    if (c.valid_until && String(c.valid_until).slice(0, 10) < today) reasons.push(`venceu em ${String(c.valid_until).slice(8, 10)}/${String(c.valid_until).slice(5, 7)}`);

    const cats = listFrom(c.category_ids);
    if (cats.length) {
      if (!ctx.categoryPath || !ctx.categoryPath.length) warnings.push(`confira: vale só para as categorias ${cats.join(', ')} (não consegui ler a categoria do produto)`);
      else if (!cats.some((id) => ctx.categoryPath.includes(id))) reasons.push('vale só para outras categorias');
    }

    const sellers = listFrom(c.seller_ids);
    if (sellers.length) {
      if (!ctx.sellerId) warnings.push(`confira: vale só para o(s) vendedor(es) ${sellers.join(', ')} (não consegui ler o vendedor do produto)`);
      else if (!sellers.includes(String(ctx.sellerId).toUpperCase())) reasons.push('vale só para outros vendedores');
    }

    const price = ctx.price;
    const min = num(c.min_purchase);
    if (min) {
      if (price && price < min) reasons.push(`exige compra mínima de R$ ${money(min)} (produto custa R$ ${money(price)})`);
      else if (!price) warnings.push(`confira: exige compra mínima de R$ ${money(min)}`);
    }

    if (reasons.length) { excluded.push({ coupon: c, reasons }); continue; }

    let discount = null;
    let finalPrice = null;
    if (price) {
      const value = Number(c.discount_value);
      discount = c.discount_type === 'percent' ? (price * value) / 100 : value;
      const cap = num(c.max_discount);
      if (cap && discount > cap) discount = cap;
      discount = Math.min(discount, price);
      finalPrice = Math.max(price - discount, 0);
    }
    applicable.push({ coupon: c, discount, finalPrice, warnings });
  }

  applicable.sort((a, b) => (b.discount || 0) - (a.discount || 0));
  return { applicable, excluded };
}


// ---------- Netshoes (cupons e produtos via Rakuten) ----------

// Lê "R$ 1.299,90", "199,90" ou "200" como número.
function brNum(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// A Rakuten não manda o desconto em campos separados: só texto livre ("10% OFF acima de R$ 200").
// Isto tenta ler o valor do texto — por isso a tela sempre mostra o texto original ao lado.
function parseDiscountText(...texts) {
  const t = texts.filter(Boolean).join(' . ');
  const pct = t.match(/(\d{1,2}(?:,\d+)?)\s*%/);
  const fixed = t.match(/R\$\s*([\d.]+(?:,\d{1,2})?)\s*(?:de\s+)?(?:desconto|off)\b/i)
    || t.match(/(?:desconto|off)\b[^.\d%]{0,20}R\$\s*([\d.]+(?:,\d{1,2})?)/i);
  const min = t.match(/(?:acima de|a partir de|compras? (?:de|acima de)|m[ií]nimo de|m[ií]nima de)\s*R\$\s*([\d.]+(?:,\d{1,2})?)/i);
  const out = { type: null, value: null, min: min ? brNum(min[1]) : null, approx: /\bat[eé]\b|\bup to\b/i.test(t) };
  if (pct) { out.type = 'percent'; out.value = brNum(pct[1]); }
  else if (fixed) { out.type = 'fixed'; out.value = brNum(fixed[1]); }
  return out;
}

async function getNetshoesContext(supabase) {
  const { data: mp } = await supabase.from('marketplaces').select('id').eq('slug', 'netshoes').maybeSingle();
  if (!mp) return { error: 'Marketplace Netshoes não encontrado no banco.' };
  const { data: creds } = await supabase
    .from('marketplace_credentials')
    .select('client_id, client_secret, extra_credential, extra_credential_2, extra_credential_3')
    .eq('marketplace_id', mp.id)
    .maybeSingle();
  if (!creds?.extra_credential || !creds?.extra_credential_2) return { error: 'Credenciais da Netshoes/Rakuten incompletas. Vá em /marketplaces.html.' };
  if (!creds.extra_credential_3) return { error: 'Falta o Web Services Token da Rakuten. Cole em /marketplaces.html.' };

  const auth = { accessToken: null, webServicesToken: creds.extra_credential_3, strategy: null, couponStrategy: null };
  let tokenError = null;
  if (creds.client_id && creds.client_secret) {
    try { auth.accessToken = await netshoesClient.getAccessToken(creds.client_id, creds.client_secret, creds.extra_credential); }
    catch (err) { tokenError = err.message; }
  }
  return { publisherId: creds.extra_credential, mid: creds.extra_credential_2, auth, tokenError };
}

function isExpired(endsAt) {
  if (!endsAt) return false;
  const day = String(endsAt).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && day < todayBR();
}

// Busca (até 2 páginas) e limpa os cupons ativos da Netshoes. Usado pela lista e pela checagem de produto.
async function loadNetshoesCoupons(ctx) {
  const all = [];
  let strategy = null;
  let rawSample = null;
  let totalMatches = 0;
  for (let page = 1; page <= 2; page += 1) {
    let items;
    try {
      items = await netshoesClient.fetchCoupons(ctx.auth, ctx.mid, { page, perPage: 100 });
    } catch (err) {
      if (page === 1) return { error: `Não consegui buscar os cupons na Rakuten: ${err.message}${ctx.tokenError ? ` (login automático: ${ctx.tokenError})` : ''}` };
      break; // falha na 2ª página: segue com o que já veio
    }
    strategy = items.strategy;
    totalMatches = items.totalMatches || totalMatches;
    if (page === 1) rawSample = items.rawSample;
    all.push(...items);
    if (!items.totalPages || page >= items.totalPages) break;
  }

  const seen = new Set();
  const coupons = [];
  let expired = 0;
  for (const c of all) {
    if (isExpired(c.endsAt)) { expired += 1; continue; }
    const key = `${c.code || ''}|${c.description || ''}|${c.clickUrl || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    coupons.push({ ...c, parsed: parseDiscountText(c.description, c.restriction) });
  }
  // Com código primeiro; depois os que vencem antes.
  coupons.sort((a, b) => (b.code ? 1 : 0) - (a.code ? 1 : 0) || String(a.endsAt || '9999').localeCompare(String(b.endsAt || '9999')));
  return { coupons, strategy, expired, totalMatches, rawSample: coupons.length ? null : rawSample };
}

async function netshoesFetchCoupons(supabase) {
  const ctx = await getNetshoesContext(supabase);
  if (ctx.error) return { status: 400, json: { error: ctx.error } };
  const r = await loadNetshoesCoupons(ctx);
  if (r.error) return { status: 502, json: { error: r.error } };
  return {
    status: 200,
    json: { ok: true, strategy: r.strategy, total: r.coupons.length, withCode: r.coupons.filter((c) => c.code).length, expired: r.expired, totalMatches: r.totalMatches, coupons: r.coupons, rawSample: r.rawSample },
  };
}

// ---------- Netshoes: este cupom serve para ESTE produto? ----------

function norm(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

const GENERIC_WORDS = new Set([
  'produtos', 'produto', 'itens', 'item', 'compras', 'compra', 'pedidos', 'pedido', 'loja', 'site', 'todos', 'todas',
  'tudo', 'demais', 'outros', 'outras', 'marketplace', 'vendidos', 'entregues', 'promocao', 'promocoes', 'oferta',
  'ofertas', 'categorias', 'categoria', 'marcas', 'marca', 'cupom', 'cupons', 'desconto', 'descontos', 'valido', 'validos',
]);

function wordTokens(value, minLen = 4) {
  return norm(value).split(/[^a-z0-9]+/).filter((w) => w.length >= minLen && !GENERIC_WORDS.has(w));
}

function hasWord(text, word) {
  return new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`).test(text);
}

// Nome do produto a partir do final do link: /tenis-nike-air-zoom-masculino-HZM-1234-026
function slugParts(url) {
  let last = '';
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    last = segs[segs.length - 1] || '';
  } catch { /* link inválido */ }
  const parts = norm(last).replace(/\.html?$/, '').split('-').filter(Boolean);
  // tira o código do produto no fim (ex: hzm-1234-026)
  while (parts.length > 3 && (/\d/.test(parts[parts.length - 1]) || parts[parts.length - 1].length <= 3)) parts.pop();
  return { last: norm(last), parts };
}

function lastSegment(url) {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    return norm(segs[segs.length - 1] || '');
  } catch { return ''; }
}

// Acha o produto na própria integração da Rakuten: busca pelas palavras do link e
// confere qual resultado tem o mesmo final de link.
async function findNetshoesProduct(ctx, url) {
  const { parts } = slugParts(url);
  if (!parts.length) return { error: 'não consegui ler o nome do produto no link' };
  const wanted = lastSegment(url);
  const startedAt = Date.now();
  let lastError = null;
  for (const size of [7, 4, 3]) {
    if (Date.now() - startedAt > 15000) break;
    const keyword = parts.slice(0, size).join(' ');
    try {
      const items = await netshoesClient.searchProducts(ctx.auth, ctx.mid, keyword, { max: 100, page: 1 });
      const hit = items.find((it) => lastSegment(it.productUrl || it.linkUrl) === wanted);
      if (hit) {
        const regular = num(hit.price);
        const price = num(hit.salePrice) || regular;
        return {
          product: {
            title: hit.itemName, price, regularPrice: regular && regular > price ? regular : null,
            imageUrl: hit.imageUrl || null, category: hit.category || null, url: hit.productUrl || url, found: true,
          },
        };
      }
    } catch (err) { lastError = err.message; }
  }
  return { error: lastError || 'o produto não apareceu na busca da Rakuten' };
}

const SKIP_INCLUSION = /^(compras?|pedidos?|todo|todos|todas|qualquer|o site|site|loja|primeira|1a|novos?|clientes?|pagamentos?|cartao|pix|app|aplicativo)\b/;

function matchNetshoesCoupon(c, product) {
  const text = norm(`${c.description || ''} . ${c.restriction || ''}`);
  const prodText = norm(`${product.title || ''} ${product.category || ''}`);
  const parsed = c.parsed || {};
  const reasons = []; const warnings = []; const notes = [];
  let uncertain = false;

  // Compra mínima
  if (parsed.min) {
    if (product.price) { if (product.price < parsed.min) reasons.push(`exige compra mínima de R$ ${money(parsed.min)} (o produto custa R$ ${money(product.price)})`); }
    else { warnings.push(`exige compra mínima de R$ ${money(parsed.min)} e não sei o preço do produto`); uncertain = true; }
  }

  // Exclusões: "exceto Nike", "não válido para Adidas"
  const exclRe = /(?:exceto(?: para)?|excecao|excecoes|nao (?:e )?valido (?:para|em)|nao vale (?:para|em)|nao se aplica a|exclui(?:ndo)?)\s*:?\s*([^.;\n]+)/g;
  for (const m of text.matchAll(exclRe)) {
    const seg = m[1].trim();
    const hits = wordTokens(seg).filter((w) => hasWord(prodText, w));
    if (hits.length) reasons.push(`a restrição exclui "${seg}" e este produto parece ser disso`);
    else notes.push(`não vale para: ${seg}`);
  }

  // Inclusões: "válido apenas para calçados"
  const inclRe = /(?:apenas|somente|exclusivo|exclusiva|valido (?:apenas |somente )?(?:para|em|nas?|nos?)|vale (?:apenas |somente )?(?:para|em))\s*:?\s*([^.;\n]+)/g;
  const inclText = text.replace(exclRe, ' '); // não deixa "não válido para X" virar "válido para X"
  for (const m of inclText.matchAll(inclRe)) {
    const seg = m[1].split(/\bexceto\b/)[0].trim();
    if (!seg || SKIP_INCLUSION.test(seg)) continue;
    const toks = wordTokens(seg);
    if (!toks.length) continue;
    if (toks.some((w) => hasWord(prodText, w))) notes.push(`a restrição cita "${seg}", que combina com o produto`);
    else { uncertain = true; warnings.push(`vale só para: "${seg}" — não achei isso no produto`); }
  }

  if (c.categories && c.categories.length && product.category) {
    const a = wordTokens(c.categories.join(' '));
    const b = wordTokens(product.category);
    if (a.length && !a.some((w) => b.includes(w))) notes.push(`categoria do cupom: ${c.categories.slice(0, 2).join(', ')}`);
  }

  // Preço com o cupom
  let discount = null; let finalPrice = null;
  if (product.price && parsed.type && parsed.value && !parsed.approx) {
    discount = parsed.type === 'percent' ? (product.price * parsed.value) / 100 : parsed.value;
    discount = Math.min(discount, product.price);
    finalPrice = Math.max(product.price - discount, 0);
  } else if (parsed.approx) {
    warnings.push('o desconto é "até X": o valor real pode ser menor');
  }

  const status = reasons.length ? 'no' : (uncertain ? 'check' : 'ok');
  return { coupon: c, status, reasons, warnings, notes, discount, finalPrice };
}

async function netshoesCheck(supabase, url, manualPrice) {
  const ctx = await getNetshoesContext(supabase);
  if (ctx.error) return { status: 400, json: { error: ctx.error } };

  const { product: found, error: productError } = await findNetshoesProduct(ctx, url);
  const slug = slugParts(url);
  const product = found
    ? { ...found }
    : { title: slug.parts.join(' ') || null, price: null, regularPrice: null, imageUrl: null, category: null, url, found: false };
  if (manualPrice) product.price = manualPrice;

  const loaded = await loadNetshoesCoupons(ctx);
  const results = { ok: [], check: [], no: [] };
  if (!loaded.error) {
    for (const c of loaded.coupons) {
      const r = matchNetshoesCoupon(c, product);
      results[r.status].push(r);
    }
    const order = (a, b) => (b.discount || 0) - (a.discount || 0) || (b.coupon.code ? 1 : 0) - (a.coupon.code ? 1 : 0);
    results.ok.sort(order);
    results.check.sort(order);
  }

  return {
    status: 200,
    json: {
      ok: true,
      marketplace: 'netshoes',
      product,
      productError: found ? null : productError,
      affiliateUrl: netshoesClient.buildAffiliateLink(ctx.publisherId, ctx.mid, product.url || url),
      results,
      totalCoupons: loaded.error ? 0 : loaded.coupons.length,
      couponsError: loaded.error || null,
      rawSample: loaded.error ? null : loaded.rawSample,
    },
  };
}

// Produtos da Netshoes (busca por palavra-chave) com o preço final já aplicando o cupom.
async function netshoesProducts(supabase, body) {
  const keyword = String(body.keyword || '').trim();
  if (!keyword) return { status: 400, json: { error: 'Digite o que buscar (ex: tênis corrida, camisa nike).' } };

  const ctx = await getNetshoesContext(supabase);
  if (ctx.error) return { status: 400, json: { error: ctx.error } };

  let items;
  try {
    items = await netshoesClient.searchProducts(ctx.auth, ctx.mid, keyword, { max: 40, page: 1 });
  } catch (err) {
    return { status: 502, json: { error: `Não consegui buscar produtos na Rakuten: ${err.message}` } };
  }

  const type = body.discount_type === 'fixed' ? 'fixed' : body.discount_type === 'percent' ? 'percent' : null;
  const value = num(body.discount_value);
  const min = num(body.min_purchase);
  const cap = num(body.max_discount);

  const products = [];
  for (const it of items) {
    const regular = num(it.price);
    const price = num(it.salePrice) || regular;
    const url = it.productUrl || it.linkUrl;
    if (!it.itemName || !url || !price) continue;

    let discount = null; let finalPrice = null; let applies = null; let note = null;
    if (type && value) {
      if (min && price < min) { applies = false; note = `abaixo da compra mínima de R$ ${money(min)}`; }
      else {
        applies = true;
        discount = type === 'percent' ? (price * value) / 100 : value;
        if (cap && discount > cap) discount = cap;
        discount = Math.min(discount, price);
        finalPrice = Math.max(price - discount, 0);
      }
    }
    products.push({
      title: it.itemName,
      price,
      regularPrice: regular && regular > price ? regular : null,
      imageUrl: it.imageUrl || null,
      url,
      affiliateUrl: netshoesClient.buildAffiliateLink(ctx.publisherId, ctx.mid, url),
      applies, discount, finalPrice, note,
    });
  }
  products.sort((a, b) => (b.applies ? 1 : 0) - (a.applies ? 1 : 0));
  return { status: 200, json: { ok: true, total: products.length, products: products.slice(0, 30) } };
}

// ---------- ações da API (chamadas por api/quicklink.js) ----------

function cleanCoupon(body) {
  const title = String(body.title || '').trim();
  const type = body.discount_type === 'fixed' ? 'fixed' : 'percent';
  const value = num(body.discount_value);
  if (!title) return { error: 'Dê um nome ao cupom.' };
  if (!value || value <= 0) return { error: 'Informe o valor do desconto.' };
  if (type === 'percent' && value > 100) return { error: 'Desconto em % não pode passar de 100.' };

  const clean = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean).join(',') || null;
  return {
    row: {
      marketplace_slug: String(body.marketplace_slug || 'mercadolivre'),
      title,
      code: String(body.code || '').trim() || null,
      discount_type: type,
      discount_value: value,
      max_discount: num(body.max_discount),
      min_purchase: num(body.min_purchase),
      category_ids: clean(body.category_ids),
      seller_ids: clean(body.seller_ids),
      valid_until: body.valid_until || null,
      notes: String(body.notes || '').trim() || null,
    },
  };
}

async function handleAction(supabase, body) {
  const action = body.action;

  if (action === 'coupons_netshoes_fetch') return netshoesFetchCoupons(supabase);
  if (action === 'coupons_netshoes_products') return netshoesProducts(supabase, body);

  if (action === 'coupons_list') {
    const { data, error } = await supabase.from('coupons').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(`${error.message} (rodou o arquivo 0004_coupons.sql no Supabase?)`);
    return { status: 200, json: { coupons: data || [] } };
  }

  if (action === 'coupons_save') {
    const { row, error } = cleanCoupon(body);
    if (error) return { status: 400, json: { error } };
    const query = body.id
      ? supabase.from('coupons').update(row).eq('id', body.id)
      : supabase.from('coupons').insert(row);
    const { error: dbError } = await query;
    if (dbError) throw new Error(`${dbError.message} (rodou o arquivo 0004_coupons.sql no Supabase?)`);
    return { status: 200, json: { ok: true } };
  }

  if (action === 'coupons_delete') {
    if (!body.id) return { status: 400, json: { error: 'id é obrigatório.' } };
    await supabase.from('coupons').delete().eq('id', body.id);
    return { status: 200, json: { ok: true } };
  }

  if (action === 'coupons_verify') {
    if (!body.id) return { status: 400, json: { error: 'id é obrigatório.' } };
    await supabase.from('coupons').update({ last_verified_at: new Date().toISOString() }).eq('id', body.id);
    return { status: 200, json: { ok: true } };
  }

  if (action === 'coupons_toggle') {
    if (!body.id) return { status: 400, json: { error: 'id é obrigatório.' } };
    await supabase.from('coupons').update({ active: Boolean(body.active) }).eq('id', body.id);
    return { status: 200, json: { ok: true } };
  }

  if (action === 'coupons_check') {
    const url = String(body.url || '').trim();
    if (!url) return { status: 400, json: { error: 'Cole o link do produto.' } };

    const marketplace = detectMarketplace(url) || String(body.marketplace || '');
    const manualPrice = num(body.price);

    // Netshoes: cupons vêm da própria integração (Rakuten) e são cruzados com o produto do link.
    if (marketplace === 'netshoes') return netshoesCheck(supabase, url, manualPrice);

    let product = null;
    let productError = null;
    if (marketplace === 'mercadolivre') {
      const token = await getMlToken(supabase);
      try { product = await fetchMercadoLivreItem(url, token); } catch (err) { productError = err.message; }
    }

    const ctx = {
      price: manualPrice || (product && product.price) || null,
      categoryPath: product ? product.categoryPath : [],
      sellerId: product ? product.sellerId : null,
    };

    const { data: all, error } = await supabase.from('coupons').select('*').eq('marketplace_slug', marketplace || 'mercadolivre');
    if (error) throw new Error(`${error.message} (rodou o arquivo 0004_coupons.sql no Supabase?)`);
    const { applicable, excluded } = matchCoupons(all || [], ctx);

    return {
      status: 200,
      json: {
        ok: true,
        marketplace,
        product,
        productError,
        priceUsed: ctx.price,
        applicable,
        excluded,
        totalCoupons: (all || []).length,
      },
    };
  }

  return { status: 400, json: { error: 'Ação desconhecida.' } };
}

module.exports = { handleAction, matchCoupons, detectMarketplace, pickMlId, num, parseDiscountText };
