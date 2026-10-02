const { getSalePrice } = require('../../src/integrations/mercadolivre/client');
const { searchProductOffers, generateShortLink } = require('../../src/integrations/shopee/client');
const { supabaseAdmin } = require('../../src/core/database/supabaseClient');

const MIN_DISCOUNT_PCT = 15;

// GET /api/scan/mercadolivre?groups=id1,id2,none
// GET /api/scan/shopee?groups=id1,id2
// Antes eram 2 functions separadas — juntei num arquivo dinâmico só.
module.exports = async function handler(req, res) {
  const slug = req.query.marketplace;
  if (slug === 'mercadolivre') return scanMercadoLivre(req, res);
  if (slug === 'shopee') return scanShopee(req, res);
  res.status(404).json({ error: `Marketplace "${slug}" não suportado.` });
};

// ---------------- Mercado Livre ----------------

async function scanMercadoLivre(req, res) {
  try {
    const { data: marketplace } = await supabaseAdmin
      .from('marketplaces')
      .select('id')
      .eq('slug', 'mercadolivre')
      .single();

    const { data: allProducts } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('marketplace_id', marketplace.id);

    const groupsParam = req.query.groups ? String(req.query.groups).split(',') : null;
    const products = groupsParam
      ? (allProducts || []).filter((p) => groupsParam.includes(p.watch_group_id || 'none'))
      : allProducts;

    let found = 0;
    const errors = [];

    for (const product of products || []) {
      try {
        found += await checkMlProduct(product, marketplace.id);
      } catch (err) {
        errors.push(`${product.source_item_id}: ${err.message}`);
        await supabaseAdmin.from('integration_logs').insert({
          marketplace_id: marketplace.id,
          level: 'error',
          message: `Falha ao checar ${product.source_item_id} (${product.title}): ${err.message}`,
        });
      }
    }

    res.status(200).json({
      ok: true,
      productsChecked: (products || []).length,
      promotionsFound: found,
      errors,
    });
  } catch (err) {
    res.status(500).json({ error: `Erro no servidor: ${err.message}` });
  }
}

async function checkMlProduct(product, marketplaceId) {
  const salePrice = await getSalePrice(product.source_item_id);

  await supabaseAdmin
    .from('products')
    .update({ last_checked_at: new Date().toISOString() })
    .eq('id', product.id);

  await supabaseAdmin.from('product_price_history').insert({ product_id: product.id, price: salePrice.amount });

  const hasPromotion =
    Boolean(salePrice.metadata?.promotion_id) ||
    (salePrice.regular_amount && salePrice.regular_amount > salePrice.amount);
  if (!hasPromotion) return 0;

  const discountRate = salePrice.regular_amount
    ? Number((((salePrice.regular_amount - salePrice.amount) / salePrice.regular_amount) * 100).toFixed(2))
    : null;

  const { data: existing } = await supabaseAdmin
    .from('promotions')
    .select('id, watch_group_id')
    .eq('product_id', product.id)
    .eq('current_price', salePrice.amount)
    .maybeSingle();

  if (existing) {
    await supabaseAdmin
      .from('promotions')
      .update({
        watch_group_id: existing.watch_group_id || product.watch_group_id || null,
        detected_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
    return 0;
  }

  await supabaseAdmin.from('promotions').insert({
    marketplace_id: marketplaceId,
    product_id: product.id,
    watch_group_id: product.watch_group_id || null,
    title: product.title,
    image_url: product.image_url,
    original_url: product.permalink,
    current_price: salePrice.amount,
    previous_price: salePrice.regular_amount || null,
    discount_rate: discountRate,
    source: 'watchlist_check',
    status: 'PENDING',
  });

  return 1;
}

// ---------------- Shopee ----------------

async function scanShopee(req, res) {
  try {
    const { data: marketplace } = await supabaseAdmin
      .from('marketplaces')
      .select('id')
      .eq('slug', 'shopee')
      .single();

    const { data: creds } = await supabaseAdmin
      .from('marketplace_credentials')
      .select('client_id, client_secret')
      .eq('marketplace_id', marketplace.id)
      .maybeSingle();

    if (!creds?.client_id || !creds?.client_secret) {
      res.status(400).json({ error: 'Credenciais da Shopee não cadastradas. Vá em /marketplaces.html.' });
      return;
    }

    const { data: allGroups } = await supabaseAdmin.from('watch_groups').select('*');
    const groupsParam = req.query.groups ? String(req.query.groups).split(',') : null;
    const groups = groupsParam ? (allGroups || []).filter((g) => groupsParam.includes(g.id)) : allGroups;

    let found = 0;
    const errors = [];

    for (const group of groups || []) {
      try {
        const keyword = group.search_keyword || group.name;
        const offers = await searchProductOffers(creds.client_id, creds.client_secret, keyword, { limit: 20 });
        for (const offer of offers) {
          found += await processShopeeOffer(offer, marketplace.id, group, creds);
        }
      } catch (err) {
        errors.push(`${group.name}: ${err.message}`);
        await supabaseAdmin.from('integration_logs').insert({
          marketplace_id: marketplace.id,
          level: 'error',
          message: `Falha ao buscar ofertas Shopee para "${group.name}": ${err.message}`,
        });
      }
    }

    res.status(200).json({ ok: true, groupsSearched: (groups || []).length, promotionsFound: found, errors });
  } catch (err) {
    res.status(500).json({ error: `Erro no servidor: ${err.message}` });
  }
}

async function processShopeeOffer(offer, marketplaceId, group, creds) {
  const discountRate = offer.priceDiscountRate || 0;
  if (discountRate < MIN_DISCOUNT_PCT) return 0;

  const originalUrl = offer.productLink || offer.offerLink;

  const { data: existing } = await supabaseAdmin
    .from('promotions')
    .select('id, watch_group_id')
    .eq('marketplace_id', marketplaceId)
    .eq('original_url', originalUrl)
    .maybeSingle();

  if (existing) {
    await supabaseAdmin
      .from('promotions')
      .update({
        current_price: offer.priceMin,
        discount_rate: discountRate,
        watch_group_id: existing.watch_group_id || group.id,
        detected_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
    return 0;
  }

  let affiliateUrl = null;
  try {
    affiliateUrl = await generateShortLink(creds.client_id, creds.client_secret, originalUrl, group.name);
  } catch (err) {
    await supabaseAdmin.from('integration_logs').insert({
      marketplace_id: marketplaceId,
      level: 'warn',
      message: `Oferta encontrada mas falhou ao gerar link de afiliado (${offer.itemId}): ${err.message}`,
    });
  }

  await supabaseAdmin.from('promotions').insert({
    marketplace_id: marketplaceId,
    watch_group_id: group.id,
    title: offer.productName,
    image_url: offer.imageUrl,
    original_url: originalUrl,
    current_price: offer.priceMin,
    previous_price: null,
    discount_rate: discountRate,
    source: 'shopee_affiliate_api',
    status: 'PENDING',
    affiliate_url: affiliateUrl,
    affiliate_url_added_at: affiliateUrl ? new Date().toISOString() : null,
  });

  return 1;
}
