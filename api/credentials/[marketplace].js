const { supabaseAdmin } = require('../../src/core/database/supabaseClient');

// GET  /api/credentials/mercadolivre | /api/credentials/shopee  -> status
// POST /api/credentials/mercadolivre  -> { client_id, client_secret }
// POST /api/credentials/shopee        -> { app_id, app_secret }
// [marketplace] no nome do arquivo faz a Vercel tratar qualquer coisa depois
// de /api/credentials/ como esse mesmo arquivo — antes eram 2 functions,
// agora é 1 só.
module.exports = async function handler(req, res) {
  const slug = req.query.marketplace;
  if (!['mercadolivre', 'shopee', 'amazon', 'netshoes'].includes(slug)) {
    res.status(404).json({ error: `Marketplace "${slug}" não suportado.` });
    return;
  }

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      res.status(500).json({ error: 'Faltam SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY na Vercel.' });
      return;
    }

    const { data: marketplace, error: mpError } = await supabaseAdmin
      .from('marketplaces')
      .select('id')
      .eq('slug', slug)
      .single();

    if (mpError || !marketplace) {
      res.status(500).json({
        error: `Não encontrei "${slug}" na tabela marketplaces (${mpError?.message || 'sem resultado'}).`,
      });
      return;
    }

    if (req.method === 'GET') {
      const { data: creds } = await supabaseAdmin
        .from('marketplace_credentials')
        .select('client_id, access_token, seller_id, extra_credential, extra_credential_2, extra_credential_3')
        .eq('marketplace_id', marketplace.id)
        .maybeSingle();

      res.status(200).json({
        hasCredentials: Boolean(creds?.client_id),
        hasAccessToken: Boolean(creds?.access_token),
        sellerId: creds?.seller_id || null,
        clientId: creds?.client_id || null,
        extraCredential: creds?.extra_credential || null,
        extraCredential2: creds?.extra_credential_2 || null,
        hasExtraCredential3: Boolean(creds?.extra_credential_3),
      });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const clientId = slug === 'shopee' ? body.app_id
        : slug === 'amazon' ? body.access_key
        : slug === 'netshoes' ? body.rakuten_client_id
        : body.client_id;
      const clientSecret = slug === 'shopee' ? body.app_secret
        : slug === 'amazon' ? body.secret_key
        : slug === 'netshoes' ? body.rakuten_client_secret
        : body.client_secret;
      const extraCredential = slug === 'amazon' ? body.associate_tag
        : slug === 'netshoes' ? body.publisher_id
        : null;
      const extraCredential2 = slug === 'netshoes' ? body.mid : null;
      // Token gerado manualmente no botão "Generate Token" da Rakuten. Se vier
      // vazio, não sobrescreve o que já estava salvo.
      const manualAccessToken = slug === 'netshoes' && body.access_token ? body.access_token.trim() : null;
      // Token da página Links > Web Services da Rakuten. Vazio = mantém o que já estava salvo.
      const webServicesToken = slug === 'netshoes' && body.web_services_token ? body.web_services_token.trim() : null;

      const missingRequired = !clientId || !clientSecret
        || (slug === 'amazon' && !extraCredential)
        || (slug === 'netshoes' && (!extraCredential || !extraCredential2));

      if (missingRequired) {
        res.status(400).json({ error: 'Preencha todos os campos de credencial.' });
        return;
      }

      const { error } = await supabaseAdmin.from('marketplace_credentials').upsert(
        {
          marketplace_id: marketplace.id,
          client_id: clientId,
          client_secret: clientSecret,
          extra_credential: extraCredential,
          extra_credential_2: extraCredential2,
          ...(manualAccessToken ? { access_token: manualAccessToken } : {}),
          ...(webServicesToken ? { extra_credential_3: webServicesToken } : {}),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'marketplace_id' }
      );

      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Método não permitido.' });
  } catch (err) {
    res.status(500).json({ error: `Erro no servidor: ${err.message}` });
  }
};
