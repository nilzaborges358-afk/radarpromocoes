const { searchProductOffers } = require('../../src/integrations/shopee/client');
const { supabaseAdmin } = require('../../src/core/database/supabaseClient');

// POST /api/groups/test-search  -> { keyword }
// Só consulta a Shopee e devolve uma prévia — não grava nada no banco.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido.' });
    return;
  }

  try {
    const { keyword } = req.body || {};
    if (!keyword) {
      res.status(400).json({ error: 'Informe uma palavra-chave para testar.' });
      return;
    }

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
      res.status(400).json({ error: 'Credenciais da Shopee não cadastradas ainda. Vá em /marketplaces.html.' });
      return;
    }

    const offers = await searchProductOffers(creds.client_id, creds.client_secret, keyword, { limit: 5 });

    res.status(200).json({
      ok: true,
      preview: offers.map((o) => ({
        title: o.productName,
        image: o.imageUrl,
        price: o.priceMin,
        discount: o.priceDiscountRate,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: `Erro ao testar busca: ${err.message}` });
  }
};
