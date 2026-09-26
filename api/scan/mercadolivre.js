const { searchItemsByCategory } = require('../../src/integrations/mercadolivre/client');
const { supabaseAdmin } = require('../../src/core/database/supabaseClient');

// GET /api/scan/mercadolivre
// Chamado pelo botão "Buscar promoções agora" do painel. Varre TODAS as categorias
// cadastradas em `watched_categories`, sozinho, sem precisar de lista de produtos específicos.
// (Antes isso rodava por cron a cada 30 min — trocado por busca manual porque o plano
// gratuito da Vercel só libera 1 execução de cron por dia.)
module.exports = async function handler(req, res) {
  const { data: marketplace } = await supabaseAdmin
    .from('marketplaces')
    .select('id')
    .eq('slug', 'mercadolivre')
    .single();

  const { data: categories } = await supabaseAdmin
    .from('watched_categories')
    .select('*')
    .eq('marketplace_id', marketplace.id)
    .eq('active', true);

  let found = 0;
  const errors = [];

  for (const category of categories || []) {
    try {
      const items = await searchItemsByCategory({ categoryId: category.category_id });
      for (const item of items) {
        found += await checkAndRecordPromotion(item, marketplace.id, category.min_discount_pct);
      }
    } catch (err) {
      errors.push(`${category.category_id}: ${err.message}`);
      await supabaseAdmin.from('integration_logs').insert({
        marketplace_id: marketplace.id,
        level: 'error',
        message: `Falha ao varrer categoria ${category.category_id}: ${err.message}`,
      });
    }
  }

  res.status(200).json({
    ok: true,
    categoriesScanned: (categories || []).length,
    promotionsFound: found,
    errors,
  });
};

async function checkAndRecordPromotion(item, marketplaceId, minDiscountPct) {
  const { data: product } = await supabaseAdmin
    .from('products')
    .upsert(
      {
        marketplace_id: marketplaceId,
        source_item_id: item.id,
        title: item.title,
        image_url: item.thumbnail,
        permalink: item.permalink,
        seller_nickname: item.seller?.nickname,
        last_checked_at: new Date().toISOString(),
      },
      { onConflict: 'marketplace_id,source_item_id' }
    )
    .select()
    .single();

  const { data: lastPrice } = await supabaseAdmin
    .from('product_price_history')
    .select('price')
    .eq('product_id', product.id)
    .order('checked_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  await supabaseAdmin
    .from('product_price_history')
    .insert({ product_id: product.id, price: item.price });

  if (!lastPrice) return 0; // primeira vez que vemos este item — só grava o preço base

  const discountPct = ((lastPrice.price - item.price) / lastPrice.price) * 100;
  if (discountPct < minDiscountPct) return 0;

  await supabaseAdmin.from('promotions').insert({
    marketplace_id: marketplaceId,
    product_id: product.id,
    title: item.title,
    image_url: item.thumbnail,
    original_url: item.permalink,
    current_price: item.price,
    previous_price: lastPrice.price,
    discount_rate: Number(discountPct.toFixed(2)),
    source: 'category_scan',
    status: 'PENDING',
  });

  return 1;
}
