const mlClient = require('../../src/integrations/mercadolivre/client');
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
        .select('*, watch_groups(name, search_keyword)')
        .eq('marketplace_id', marketplace.id)
        .order('created_at', { ascending: false });
      const { data: marketplaces } = await supabaseAdmin.from('marketplaces').select('slug, name').order('name');

      res.status(200).json({ groups: groups || [], products: products || [], marketplaces: marketplaces || [] });
      return;
    }

    if (req.method === 'POST') {
      const { url, watch_group_id } = req.body || {};
      if (!url) {
        res.status(400).json({ error: 'Cole um link de produto do Mercado Livre.' });
        return;
      }

      // Abre links curtos (meli.la) — que levam à página /social/ do divulgador — e reconhece links de
      // catálogo (/p/MLB...), de anúncio (MLB-123..., ?wid=) e de User Product (/up/MLBU...).
      const resolved = await mlClient.resolveMlUrl(String(url).trim());
      const parsed = resolved.parsed;
      const finalUrl = resolved.url;
      if (!parsed) {
        res.status(400).json({
          error: `Não consegui identificar o produto nesse link${resolved.note ? ` (${resolved.note})` : ''}. Abra o link no navegador, espere a página do produto carregar e cole a URL completa que aparece na barra de endereço.`,
        });
        return;
      }

      const { token, reason: tokenReason } = await mlClient.getAccessToken(supabaseAdmin);

      let snap;
      try {
        snap = await mlClient.getItemSnapshot({
          id: parsed.id,
          kind: parsed.kind,
          token,
          url: finalUrl,
          needDetails: true,
        });
      } catch (err) {
        res.status(400).json({
          error: `Não consegui ler esse produto no Mercado Livre. ${token ? '' : `Sem token da sua conta: ${tokenReason}. `}Detalhes: ${err.message}`,
        });
        return;
      }

      // Link de catálogo: guarda o código do CATÁLOGO (o scan segue o anúncio vencedor do momento, que muda).
      // Link de anúncio: guarda o código do anúncio.
      const isCatalog = parsed.kind === 'catalog';
      const itemId = isCatalog ? parsed.id : snap.itemId || parsed.id;

      const { data: product, error } = await supabaseAdmin
        .from('products')
        .upsert(
          {
            marketplace_id: marketplace.id,
            source_item_id: itemId,
            title: snap.title || 'Produto do Mercado Livre',
            image_url: snap.thumbnail,
            permalink: isCatalog ? `https://www.mercadolivre.com.br/p/${parsed.id}` : snap.permalink || finalUrl,
            seller_nickname: snap.sellerNickname,
            watch_group_id: watch_group_id || null,
            last_checked_at: new Date().toISOString(),
          },
          { onConflict: 'marketplace_id,source_item_id' }
        )
        .select()
        .single();

      if (error) throw new Error(error.message);

      // Primeiro ponto do histórico de preço (a comparação "caiu contra a última semana" precisa dele).
      await supabaseAdmin.from('product_price_history').insert({ product_id: product.id, price: snap.price });

      res.status(200).json({
        ok: true,
        product,
        source: snap.source,
        warning:
          snap.source === 'page'
            ? 'A API do Mercado Livre bloqueou a leitura; usei a página pública do produto. Funciona, mas pode falhar nas próximas buscas.'
            : null,
      });
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
