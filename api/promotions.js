const { supabaseAdmin } = require('../src/core/database/supabaseClient');

// POST /api/promotions
// Cadastro manual — usado quando o marketplace não tem API de afiliados
// (Magalu hoje; qualquer outro no futuro que fique sem automação).
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido.' });
    return;
  }

  try {
    const {
      marketplace_slug,
      title,
      image_url,
      original_url,
      affiliate_url,
      current_price,
      previous_price,
      watch_group_id,
    } = req.body || {};

    if (!marketplace_slug || !title || !original_url || !current_price) {
      res.status(400).json({ error: 'Preencha ao menos marketplace, título, link original e preço atual.' });
      return;
    }

    const { data: marketplace, error: mpError } = await supabaseAdmin
      .from('marketplaces')
      .select('id')
      .eq('slug', marketplace_slug)
      .single();

    if (mpError || !marketplace) {
      res.status(400).json({ error: `Marketplace "${marketplace_slug}" não encontrado.` });
      return;
    }

    const discountRate = previous_price && previous_price > current_price
      ? Number((((previous_price - current_price) / previous_price) * 100).toFixed(2))
      : null;

    const { data, error } = await supabaseAdmin.from('promotions').insert({
      marketplace_id: marketplace.id,
      watch_group_id: watch_group_id || null,
      title,
      image_url: image_url || null,
      original_url,
      affiliate_url: affiliate_url || null,
      affiliate_url_added_at: affiliate_url ? new Date().toISOString() : null,
      current_price,
      previous_price: previous_price || null,
      discount_rate: discountRate,
      source: 'manual_entry',
      status: affiliate_url ? 'AFFILIATED' : 'PENDING',
    }).select().single();

    if (error) throw new Error(error.message);

    res.status(200).json({ ok: true, promotion: data });
  } catch (err) {
    res.status(500).json({ error: `Erro no servidor: ${err.message}` });
  }
};
