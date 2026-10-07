const { getSalePrice } = require('../../src/integrations/mercadolivre/client');
const { searchProductOffers, generateShortLink } = require('../../src/integrations/shopee/client');
const netshoesClient = require('../../src/integrations/netshoes/client');
const { supabaseAdmin } = require('../../src/core/database/supabaseClient');

const MIN_DISCOUNT_PCT = 10; // era 15 — baixei pra achar mais resultado em categorias mais de nicho

// GET /api/scan/mercadolivre?groups=id1,id2,none
// GET /api/scan/shopee?groups=id1,id2
// Antes eram 2 functions separadas — juntei num arquivo dinâmico só.
module.exports = async function handler(req, res) {
  const slug = req.query.marketplace;
  if (slug === 'mercadolivre') return scanMercadoLivre(req, res);
  if (slug === 'shopee') return scanShopee(req, res);
  if (slug === 'amazon') return scanAmazon(req, res);
  if (slug === 'netshoes') return scanNetshoes(req, res);
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

// ---------------- Amazon ----------------
//
// A Creators API da Amazon (que substituiu a antiga PA-API, desativada em 2026)
// só libera consulta de catálogo depois que a conta de Associado tiver pelo
// menos 10 vendas qualificadas nos últimos 30 dias — é uma trava da própria
// Amazon, documentada por eles. Enquanto isso, não dá pra implementar a
// chamada de verdade sem arriscar inventar um endpoint que eu não confirmei.
// Assim que a conta atingir o requisito e a documentação completa abrir,
// essa função troca por uma implementação real.
async function scanAmazon(req, res) {
  try {
    const { data: marketplace } = await supabaseAdmin
      .from('marketplaces')
      .select('id')
      .eq('slug', 'amazon')
      .single();

    const { data: creds } = await supabaseAdmin
      .from('marketplace_credentials')
      .select('client_id, client_secret, extra_credential')
      .eq('marketplace_id', marketplace.id)
      .maybeSingle();

    if (!creds?.client_id || !creds?.client_secret || !creds?.extra_credential) {
      res.status(400).json({ error: 'Credenciais da Amazon não cadastradas. Vá em /marketplaces.html.' });
      return;
    }

    res.status(200).json({
      ok: true,
      productsChecked: 0,
      promotionsFound: 0,
      errors: [],
      note:
        'Credenciais salvas, mas a Creators API da Amazon só libera consulta depois que sua conta tiver 10 vendas qualificadas nos últimos 30 dias. Assim que isso acontecer, me avise pra eu implementar a busca de verdade.',
    });
  } catch (err) {
    res.status(500).json({ error: `Erro no servidor: ${err.message}` });
  }
}

// ---------------- Netshoes (via Rakuten Advertising) ----------------

async function scanNetshoes(req, res) {
  try {
    const { data: marketplace } = await supabaseAdmin
      .from('marketplaces')
      .select('id')
      .eq('slug', 'netshoes')
      .single();

    const { data: creds } = await supabaseAdmin
      .from('marketplace_credentials')
      .select('client_id, client_secret, extra_credential, extra_credential_2')
      .eq('marketplace_id', marketplace.id)
      .maybeSingle();

    if (!creds?.client_id || !creds?.client_secret || !creds?.extra_credential || !creds?.extra_credential_2) {
      res.status(400).json({ error: 'Credenciais da Netshoes/Rakuten incompletas. Vá em /marketplaces.html.' });
      return;
    }

    const publisherId = creds.extra_credential;
    const mid = creds.extra_credential_2;

    const accessToken = await netshoesClient.getAccessToken(creds.client_id, creds.client_secret);

    const { data: allGroups } = await supabaseAdmin.from('watch_groups').select('*');
    const groupsParam = req.query.groups ? String(req.query.groups).split(',') : null;
    const groups = groupsParam ? (allGroups || []).filter((g) => groupsParam.includes(g.id)) : allGroups;

    let found = 0;
    const errors = [];

    for (const group of groups || []) {
      try {
        const keyword = group.search_keyword || group.name;
        const items = await netshoesClient.searchProducts(accessToken, mid, keyword);
        for (const item of items) {
          found += await processNetshoesItem(item, marketplace.id, group, publisherId, mid);
        }
      } catch (err) {
        errors.push(`${group.name}: ${err.message}`);
        await supabaseAdmin.from('integration_logs').insert({
          marketplace_id: marketplace.id,
          level: 'error',
          message: `Falha ao buscar produtos Netshoes para "${group.name}": ${err.message}`,
        });
      }
    }

    res.status(200).json({ ok: true, groupsSearched: (groups || []).length, promotionsFound: found, errors });
  } catch (err) {
    res.status(500).json({ error: `Erro no servidor: ${err.message}` });
  }
}

// ATENÇÃO: os nomes de campo do item (itemName, price, salePrice, imageUrl,
// linkUrl, sku) ainda não foram confirmados contra uma resposta real da API —
// ajuste aqui assim que testar com credenciais de verdade.
async function processNetshoesItem(item, marketplaceId, group, publisherId, mid) {
  const title = item.itemName || item.productName || item.name;
  const productUrl = item.linkUrl || item.productUrl || item.url;
  const price = parseFloat(item.salePrice || item.price);
  const regularPrice = item.price && item.salePrice ? parseFloat(item.price) : null;

  if (!title || !productUrl || !price) return 0; // resposta em formato inesperado — pula sem quebrar o resto

  const discountRate = regularPrice && regularPrice > price
    ? Number((((regularPrice - price) / regularPrice) * 100).toFixed(2))
    : null;

  if (!discountRate || discountRate < MIN_DISCOUNT_PCT) return 0;

  const { data: existing } = await supabaseAdmin
    .from('promotions')
    .select('id, watch_group_id')
    .eq('marketplace_id', marketplaceId)
    .eq('original_url', productUrl)
    .maybeSingle();

  const affiliateUrl = netshoesClient.buildAffiliateLink(publisherId, mid, productUrl);

  if (existing) {
    await supabaseAdmin
      .from('promotions')
      .update({
        current_price: price,
        discount_rate: discountRate,
        watch_group_id: existing.watch_group_id || group.id,
        detected_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
    return 0;
  }

  await supabaseAdmin.from('promotions').insert({
    marketplace_id: marketplaceId,
    watch_group_id: group.id,
    title,
    image_url: item.imageUrl || item.image || null,
    original_url: productUrl,
    current_price: price,
    previous_price: regularPrice,
    discount_rate: discountRate,
    source: 'netshoes_rakuten_api',
    status: 'PENDING',
    affiliate_url: affiliateUrl,
    affiliate_url_added_at: new Date().toISOString(),
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
        // Suporta várias palavras-chave por grupo, separadas por vírgula —
        // busca cada uma separadamente, pra trazer produtos de fato distintos
        // dentro do nicho, em vez de uma palavra genérica dominada por um
        // único produto campeão de vendas.
        const keywords = (group.search_keyword || group.name)
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean);

        const perKeywordLimit = Math.max(10, Math.floor(40 / keywords.length));

        for (const keyword of keywords) {
          const offers = await searchProductOffers(creds.client_id, creds.client_secret, keyword, { limit: perKeywordLimit });
          for (const offer of offers) {
            found += await processShopeeOffer(offer, marketplace.id, group, creds);
          }
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

// Checa se o título do produto realmente tem a ver com a palavra-chave buscada.
// A busca da Shopee é por relevância ampla — alguns vendedores colocam palavras
// populares no título só pra aparecer em mais buscas ("keyword stuffing"). Isso
// descarta o caso óbvio de vazamento (ex: produto de cozinha aparecendo na
// busca de "corrida"), sem precisar de um filtro perfeito.
function titleMatchesKeyword(title, keyword) {
  const stopWords = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'com', 'para', 'em', 'a', 'o']);
  const words = keyword
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
  if (words.length === 0) return true; // palavra-chave só com termos curtos — não filtra
  const titleLower = title.toLowerCase();
  return words.some((w) => titleLower.includes(w));
}

async function processShopeeOffer(offer, marketplaceId, group, creds) {
  const discountRate = offer.priceDiscountRate || 0;
  if (discountRate < MIN_DISCOUNT_PCT) return 0;

  const keyword = group.search_keyword || group.name;
  if (!titleMatchesKeyword(offer.productName || '', keyword)) return 0;

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
