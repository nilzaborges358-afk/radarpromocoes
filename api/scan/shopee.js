const { searchProductOffers, generateShortLink } = require('../../src/integrations/shopee/client');
const { supabaseAdmin } = require('../../src/core/database/supabaseClient');

const MIN_DISCOUNT_PCT = 15; // ajustável depois, se quiser um filtro por grupo

// GET /api/scan/shopee
// Usa cada `watch_group` (Corrida, Casa, Materiais de limpeza) como palavra-chave
// de busca na Shopee. Diferente do Mercado Livre, aqui o link de afiliado já sai
// pronto — não precisa de passo manual.
module.exports = async function handler(req, res) {
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

    const { data: groups } = await supabaseAdmin.from('watch_groups').select('*');

    let found = 0;
    const errors = [];

    for (const group of groups || []) {
      try {
        const offers = await searchProductOffers(creds.client_id, creds.client_secret, group.name, { limit: 20 });
        for (const offer of offers) {
          found += await processOffer(offer, marketplace.id, group, creds);
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
};

async function processOffer(offer, marketplaceId, group, creds) {
  const discountRate = offer.priceDiscountRate || 0;
  if (discountRate < MIN_DISCOUNT_PCT) return 0;

  const { data: existing } = await supabaseAdmin
    .from('promotions')
    .select('id')
    .eq('marketplace_id', marketplaceId)
    .eq('original_url', offer.productLink || offer.offerLink)
    .eq('current_price', offer.priceMin)
    .maybeSingle();

  if (existing) return 0;

  let affiliateUrl = null;
  try {
    affiliateUrl = await generateShortLink(
      creds.client_id,
      creds.client_secret,
      offer.productLink || offer.offerLink,
      group.name
    );
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
    original_url: offer.productLink || offer.offerLink,
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
