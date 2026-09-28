const { supabaseAdmin } = require('../../../src/core/database/supabaseClient');

// GET /api/auth/mercadolivre/login
module.exports = async function handler(req, res) {
  const { data: marketplace } = await supabaseAdmin
    .from('marketplaces')
    .select('id')
    .eq('slug', 'mercadolivre')
    .single();

  const { data: creds } = await supabaseAdmin
    .from('marketplace_credentials')
    .select('client_id')
    .eq('marketplace_id', marketplace.id)
    .maybeSingle();

  if (!creds?.client_id) {
    res
      .status(400)
      .send('Nenhum Client ID cadastrado ainda. Vá em /marketplaces.html e salve suas credenciais do Mercado Livre primeiro.');
    return;
  }

  const redirectUri = `https://${req.headers.host}/api/auth/mercadolivre/callback`;

  const authUrl =
    `https://auth.mercadolivre.com.br/authorization` +
    `?response_type=code&client_id=${encodeURIComponent(creds.client_id)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.writeHead(302, { Location: authUrl });
  res.end();
};
