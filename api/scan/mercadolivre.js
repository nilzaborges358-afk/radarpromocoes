const { getSalePrice } = require('../../src/integrations/mercadolivre/client');
const { supabaseAdmin } = require('../../src/core/database/supabaseClient');

// GET /api/scan/mercadolivre
// Chamado pelo botão "Buscar promoções agora". Para cada produto cadastrado na
// sua lista de vigilância (watchlist), consulta o preço atual via
// /items/{id}/sale_price — sem token, porque os produtos vigiados são de
// outros vendedores (o token da sua loja só tem permissão sobre os seus
// próprios itens, e devolve access_denied para itens de terceiros).
module.exports = async function handler(req, res) {
  try {
    const { data: marketplace } = await supabaseAdmin
      .from('marketplaces')
      .select('id')
      .eq('slug', 'mercadolivre')
      .single();

    const { data: products } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('marketplace_id', marketplace.id);

    let found = 0;
    const errors = [];

    for (const product of products || []) {
      try {
        found += await checkProduct(product, marketplace.id);
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
};

async function checkProduct(product, marketplaceId) {
  const salePrice = await getSalePrice(product.source_item_id); // sem token — item de terceiro

  await supabaseAdmin
    .from('products')
    .update({ last_checked_at: new Date().toISOString() })
    .eq('id', product.id);

  await supabaseAdmin
    .from('product_price_history')
    .insert({ product_id: product.id, price: salePrice.amount });

  const hasPromotion = Boolean(salePrice.metadata?.promotion_id) ||
    (salePrice.regular_amount && salePrice.regular_amount > salePrice.amount);

  if (!hasPromotion) return 0;

  const { data: existing } = await supabaseAdmin
    .from('promotions')
    .select('id')
    .eq('product_id', product.id)
    .eq('current_price', salePrice.amount)
    .maybeSingle();

  if (existing) return 0;

  const discountRate = salePrice.regular_amount
    ? Number((((salePrice.regular_amount - salePrice.amount) / salePrice.regular_amount) * 100).toFixed(2))
    : null;

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
