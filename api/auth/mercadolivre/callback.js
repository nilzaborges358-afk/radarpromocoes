const { exchangeCodeForToken } = require('../../../src/integrations/mercadolivre/client');
const { supabaseAdmin } = require('../../../src/core/database/supabaseClient');

// GET /api/auth/mercadolivre/callback?code=...
module.exports = async function handler(req, res) {
  const { code } = req.query;
  if (!code) {
    res.status(400).send('Parâmetro "code" ausente.');
    return;
  }

  try {
    const { data: marketplace } = await supabaseAdmin
      .from('marketplaces')
      .select('id')
      .eq('slug', 'mercadolivre')
      .single();

    const { data: creds } = await supabaseAdmin
      .from('marketplace_credentials')
      .select('client_id, client_secret')
      .eq('marketplace_id', marketplace.id)
      .single();

    if (!creds?.client_id || !creds?.client_secret) {
      res.status(400).send('Credenciais não encontradas. Cadastre em /marketplaces.html antes de conectar.');
      return;
    }

    const redirectUri = `https://${req.headers.host}/api/auth/mercadolivre/callback`;

    const token = await exchangeCodeForToken({
      code,
      clientId: creds.client_id,
      clientSecret: creds.client_secret,
      redirectUri,
    });

    const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();

    // Upsert preservando client_id/client_secret já salvos (mandamos de novo pra garantir).
    await supabaseAdmin.from('marketplace_credentials').upsert(
      {
        marketplace_id: marketplace.id,
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        token_expires_at: expiresAt,
        seller_id: String(token.user_id),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'marketplace_id' }
    );

    res.status(200).send(
      'Conta do Mercado Livre conectada com sucesso. Pode fechar esta aba e voltar ao painel.'
    );
  } catch (err) {
    res.status(500).send(`Erro ao conectar: ${err.message}`);
  }
};
