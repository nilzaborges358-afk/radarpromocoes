const { generateShortLink } = require('../src/integrations/shopee/client');
const { buildAffiliateLink } = require('../src/integrations/netshoes/client');
const { supabaseAdmin } = require('../src/core/database/supabaseClient');

// POST /api/quicklink  -> { marketplace: 'shopee' | 'netshoes', url }
// Gera o link de afiliado na hora, sem precisar que o produto apareça numa
// busca por grupo antes. Mercado Livre não tem endpoint aqui porque não
// existe API de afiliados oficial pra isso — a tela encaminha pro site deles.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido.' });
    return;
  }

  try {
    const { marketplace: slug, url } = req.body || {};
    if (!slug || !url) {
      res.status(400).json({ error: 'Informe o marketplace e o link.' });
      return;
    }

    const { data: marketplace, error: mpError } = await supabaseAdmin
      .from('marketplaces')
      .select('id')
      .eq('slug', slug)
      .single();

    if (mpError || !marketplace) {
      res.status(400).json({ error: `Marketplace "${slug}" não encontrado.` });
      return;
    }

    const { data: creds } = await supabaseAdmin
      .from('marketplace_credentials')
      .select('client_id, client_secret, extra_credential, extra_credential_2')
      .eq('marketplace_id', marketplace.id)
      .maybeSingle();

    if (slug === 'shopee') {
      if (!creds?.client_id || !creds?.client_secret) {
        res.status(400).json({ error: 'Credenciais da Shopee não cadastradas. Vá em /marketplaces.html.' });
        return;
      }
      const link = await generateShortLink(creds.client_id, creds.client_secret, url);
      if (!link) {
        res.status(500).json({ error: 'A Shopee não devolveu um link (confira se a URL é de um produto válido).' });
        return;
      }
      res.status(200).json({ ok: true, affiliateUrl: link });
      return;
    }

    if (slug === 'netshoes') {
      if (!creds?.extra_credential || !creds?.extra_credential_2) {
        res.status(400).json({ error: 'Credenciais da Netshoes/Rakuten não cadastradas. Vá em /marketplaces.html.' });
        return;
      }
      const link = buildAffiliateLink(creds.extra_credential, creds.extra_credential_2, url);
      res.status(200).json({ ok: true, affiliateUrl: link });
      return;
    }

    res.status(400).json({ error: `Geração instantânea não disponível para "${slug}" (sem API de afiliados).` });
  } catch (err) {
    res.status(500).json({ error: `Erro no servidor: ${err.message}` });
  }
};
