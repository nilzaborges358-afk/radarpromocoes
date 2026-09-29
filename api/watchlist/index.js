const { extractItemIdFromUrl, authenticatedGet } = require('../../src/integrations/mercadolivre/client');
const { supabaseAdmin } = require('../../src/core/database/supabaseClient');

// GET    /api/watchlist            -> { groups, products }
// POST   /api/watchlist            -> { url, watch_group_id }  adiciona um produto
// DELETE /api/watchlist?id=...     -> remove um produto da lista
module.exports = async function handler(req, res) {
  try {
    const { data: marketplace } = await supabaseAdmin
      .from('marketplaces')
      .select('id')
      .eq('slug', 'mercadolivre')
      .single();

    if (req.method === 'GET') {
      const { data: groups } = await supabaseAdmin.from('watch_groups').select('*').order('name');
      const { data: products } = await supabaseAdmin
        .from('products')
        .select('*, watch_groups(name)')
        .eq('marketplace_id', marketplace.id)
        .order('created_at', { ascending: false });

      res.status(200).json({ groups: groups || [], products: products || [] });
      return;
    }

    if (req.method === 'POST') {
      const { url, watch_group_id } = req.body || {};
      if (!url) {
        res.status(400).json({ error: 'Cole um link de produto do Mercado Livre.' });
        return;
      }

      const itemId = extractItemIdFromUrl(url);
      if (!itemId) {
        res.status(400).json({
          error: 'Não consegui identificar o código do produto (MLB...) nesse link. Confira se é o link direto da página do produto.',
        });
        return;
      }

      // Busca dados do item. Tenta com token da sua loja (se existir), senão sem auth
      // (o recurso /items/{id} costuma ser público para leitura).
      const { data: creds } = await supabaseAdmin
        .from('marketplace_credentials')
        .select('access_token')
        .eq('marketplace_id', marketplace.id)
        .maybeSingle();

      let item;
      try {
        item = await authenticatedGet(`/items/${itemId}`, creds?.access_token);
      } catch (err) {
        res.status(400).json({ error: `Não consegui buscar esse produto no Mercado Livre: ${err.message}` });
        return;
      }

      const { data: product, error } = await supabaseAdmin
        .from('products')
        .upsert(
          {
            marketplace_id: marketplace.id,
            source_item_id: itemId,
            title: item.title,
            image_url: item.thumbnail,
            permalink: item.permalink,
            seller_nickname: item.seller?.nickname,
            watch_group_id: watch_group_id || null,
            last_checked_at: new Date().toISOString(),
          },
          { onConflict: 'marketplace_id,source_item_id' }
        )
        .select()
        .single();

      if (error) throw new Error(error.message);

      res.status(200).json({ ok: true, product });
      return;
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) {
        res.status(400).json({ error: 'id é obrigatório.' });
        return;
      }
      await supabaseAdmin.from('products').delete().eq('id', id);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Método não permitido.' });
  } catch (err) {
    res.status(500).json({ error: `Erro no servidor: ${err.message}` });
  }
};
