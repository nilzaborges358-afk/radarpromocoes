const ml = require('../integrations/mercadolivre/client');

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
  if (token) {
    try { return await ml.authenticatedGet(path, token); } catch { /* tenta público */ }
  }
  return ml.publicGet(path);
}

async function fetchMercadoLivreItem(rawUrl, token) {
  const url = await resolveShortUrl(rawUrl);
  const { id, catalog } = pickMlId(url);
  if (!id) {
    throw new Error('Não achei o código do produto (MLB...) nesse link. Cole o link completo da página do produto (links curtos como meli.la às vezes não abrem).');
  }

  let item;
  try {
    item = await mlGet(`/items/${id}`, token);
  } catch (err) {
    if (!catalog) throw new Error(`O Mercado Livre não devolveu esse produto (${err.message.slice(0, 160)}).`);
    // Link de catálogo: pega o anúncio vencedor do produto
    const product = await mlGet(`/products/${id}`, token).catch(() => null);
    const winner = product && product.buy_box_winner && product.buy_box_winner.item_id;
    if (!winner) throw new Error('Esse é um link de catálogo e não consegui descobrir o anúncio vencedor. Abra o produto, clique em um vendedor e cole esse link.');
    item = await mlGet(`/items/${winner}`, token);
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

  // Caminho de categorias (de geral para específica) — cupom costuma valer para categoria "mãe"
  let categoryPath = item.category_id ? [String(item.category_id).toUpperCase()] : [];
  if (item.category_id) {
    try {
      const cat = await mlGet(`/categories/${item.category_id}`, token);
      const path = (cat.path_from_root || []).map((c) => String(c.id).toUpperCase());
      if (path.length) categoryPath = path;
    } catch { /* fica só com a categoria do item */ }
  }

  return {
    marketplace: 'mercadolivre',
    id: item.id,
    title: item.title,
    price,
    originalPrice: originalPrice && originalPrice > price ? originalPrice : null,
    promotionType,
    thumbnail: item.thumbnail ? String(item.thumbnail).replace(/^http:/, 'https:') : null,
    permalink: item.permalink || url,
    categoryPath,
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
    if (!c.active) reasons.push('cupom desativado');
    if (c.valid_until && String(c.valid_until).slice(0, 10) < today) reasons.push(`venceu em ${String(c.valid_until).slice(8, 10)}/${String(c.valid_until).slice(5, 7)}`);

    const cats = listFrom(c.category_ids);
    if (cats.length) {
      if (!ctx.categoryPath || !ctx.categoryPath.length) reasons.push('não consegui ler a categoria do produto');
      else if (!cats.some((id) => ctx.categoryPath.includes(id))) reasons.push('vale só para outras categorias');
    }

    const sellers = listFrom(c.seller_ids);
    if (sellers.length) {
      if (!ctx.sellerId) reasons.push('não consegui ler o vendedor do produto');
      else if (!sellers.includes(String(ctx.sellerId).toUpperCase())) reasons.push('vale só para outros vendedores');
    }

    const price = ctx.price;
    const min = num(c.min_purchase);
    const warnings = [];
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

    let product = null;
    let productError = null;
    if (marketplace === 'mercadolivre') {
      const { data: mp } = await supabase.from('marketplaces').select('id').eq('slug', 'mercadolivre').maybeSingle();
      let token = null;
      if (mp) {
        const { data: creds } = await supabase.from('marketplace_credentials').select('access_token').eq('marketplace_id', mp.id).maybeSingle();
        token = creds && creds.access_token;
      }
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

module.exports = { handleAction, matchCoupons, detectMarketplace, pickMlId, num };
