const { supabaseAdmin } = require('../src/core/database/supabaseClient');
const { SimilarIndex } = require('../src/core/dedupe');

// POST /api/promotions
// Cadastro manual — usado quando o marketplace não tem API de afiliados
// (Magalu hoje; qualquer outro no futuro que fique sem automação).
// POST /api/promotions { action: 'dedupe' }
// Limpa o que já está salvo: quando o mesmo produto aparece em vários anúncios, mantém UM
// (o já afiliado; senão o mais barato) e marca os outros PENDENTES como IGNORADOS.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido.' });
    return;
  }

  try {
    if (req.body && req.body.action === 'dedupe') {
      await dedupeExisting(res);
      return;
    }

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

// Só olha os últimos 30 dias e só promoções PENDENTES/AFILIADAS. Compara dentro de cada marketplace
// (o mesmo produto na Shopee e na Netshoes são ofertas diferentes). Nunca mexe em quem já foi afiliado.
async function dedupeExisting(res) {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const rows = [];
  for (let from = 0; from < 5000; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from('promotions')
      .select('id, marketplace_id, title, current_price, status')
      .in('status', ['PENDING', 'AFFILIATED'])
      .gte('detected_at', since)
      .order('detected_at', { ascending: false })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  const byMarketplace = new Map();
  rows.forEach((r) => {
    if (!byMarketplace.has(r.marketplace_id)) byMarketplace.set(r.marketplace_id, []);
    byMarketplace.get(r.marketplace_id).push(r);
  });

  const toIgnore = [];
  for (const list of byMarketplace.values()) {
    // Quem fica: já afiliados primeiro, depois o mais barato.
    list.sort((a, b) => (a.status === 'AFFILIATED' ? 0 : 1) - (b.status === 'AFFILIATED' ? 0 : 1) || Number(a.current_price) - Number(b.current_price));
    const index = new SimilarIndex();
    for (const r of list) {
      if (index.findSimilar(r.title)) { if (r.status === 'PENDING') toIgnore.push(r.id); continue; }
      index.add(r.title, r);
    }
  }

  for (let i = 0; i < toIgnore.length; i += 100) {
    const { error } = await supabaseAdmin.from('promotions').update({ status: 'IGNORED' }).in('id', toIgnore.slice(i, i + 100));
    if (error) throw new Error(error.message);
  }
  res.status(200).json({ ok: true, checked: rows.length, ignored: toIgnore.length });
}
