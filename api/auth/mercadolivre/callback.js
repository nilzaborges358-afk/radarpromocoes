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
    const token = await exchangeCodeForToken({
      code,
      clientId: process.env.MERCADOLIVRE_CLIENT_ID,
      clientSecret: process.env.MERCADOLIVRE_CLIENT_SECRET,
      redirectUri: process.env.MERCADOLIVRE_REDIRECT_URI,
    });

    const { data: marketplace } = await supabaseAdmin
      .from('marketplaces')
      .select('id')
      .eq('slug', 'mercadolivre')
      .single();

    const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();

    // Upsert: só a tabela de credenciais é tocada aqui — nunca métricas junto.
    await supabaseAdmin.from('marketplace_credentials').upsert(
      {
        marketplace_id: marketplace.id,
        client_id: process.env.MERCADOLIVRE_CLIENT_ID,
        client_secret: process.env.MERCADOLIVRE_CLIENT_SECRET,
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
