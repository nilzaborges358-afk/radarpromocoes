const { supabaseAdmin } = require('../src/core/database/supabaseClient');
const { searchProductOffers } = require('../src/integrations/shopee/client');

// GET    /api/groups                          -> lista todos
// POST   /api/groups  { name, search_keyword } -> cria um grupo
// POST   /api/groups  { action: 'test', keyword } -> testa uma busca sem salvar
// DELETE /api/groups?id=...                   -> remove um grupo
module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { data, error } = await supabaseAdmin.from('watch_groups').select('*').order('name');
      if (error) throw new Error(error.message);
      res.status(200).json({ groups: data || [] });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};

      if (body.action === 'test') {
        await testSearch(req, res, body.keyword);
        return;
      }

      const { name, search_keyword } = body;
      if (!name || !search_keyword) {
        res.status(400).json({ error: 'Preencha o nome do grupo e a palavra-chave de busca.' });
        return;
      }

      const { data, error } = await supabaseAdmin
        .from('watch_groups')
        .insert({ name: name.trim(), search_keyword: search_keyword.trim() })
        .select()
        .single();

      if (error) {
        if (error.code === '23505') {
          res.status(400).json({ error: 'Já existe um grupo com esse nome.' });
          return;
        }
        throw new Error(error.message);
      }

      res.status(200).json({ ok: true, group: data });
      return;
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) {
        res.status(400).json({ error: 'id é obrigatório.' });
        return;
      }
      await supabaseAdmin.from('watch_groups').delete().eq('id', id);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Método não permitido.' });
  } catch (err) {
    res.status(500).json({ error: `Erro no servidor: ${err.message}` });
  }
};

async function testSearch(req, res, keyword) {
  if (!keyword) {
    res.status(400).json({ error: 'Informe uma palavra-chave para testar.' });
    return;
  }

  const { data: marketplace } = await supabaseAdmin.from('marketplaces').select('id').eq('slug', 'shopee').single();
  const { data: creds } = await supabaseAdmin
    .from('marketplace_credentials')
    .select('client_id, client_secret')
    .eq('marketplace_id', marketplace.id)
    .maybeSingle();

  if (!creds?.client_id || !creds?.client_secret) {
    res.status(400).json({ error: 'Credenciais da Shopee não cadastradas ainda. Vá em /marketplaces.html.' });
    return;
  }

  const keywords = keyword.split(',').map((k) => k.trim()).filter(Boolean);
  const perKeywordLimit = Math.max(2, Math.floor(8 / keywords.length));

  let allOffers = [];
  for (const kw of keywords) {
    const offers = await searchProductOffers(creds.client_id, creds.client_secret, kw, { limit: perKeywordLimit });
    allOffers = allOffers.concat(offers);
  }

  res.status(200).json({
    ok: true,
    preview: allOffers.map((o) => ({ title: o.productName, image: o.imageUrl, price: o.priceMin, discount: o.priceDiscountRate })),
  });
}
