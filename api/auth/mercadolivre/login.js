const crypto = require('crypto');
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

  // PKCE: gera o "code_verifier" (segredo temporário) e o "code_challenge" (hash dele).
  // O Mercado Livre exige isso desde a criação de apps mais recentes.
  const codeVerifier = crypto.randomBytes(64).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  // Guarda o verifier temporariamente — vamos precisar dele de novo no callback.
  await supabaseAdmin
    .from('marketplace_credentials')
    .update({ pending_code_verifier: codeVerifier })
    .eq('marketplace_id', marketplace.id);

  const redirectUri = `https://${req.headers.host}/api/auth/mercadolivre/callback`;

  const authUrl =
    `https://auth.mercadolivre.com.br/authorization` +
    `?response_type=code&client_id=${encodeURIComponent(creds.client_id)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}` +
    `&code_challenge_method=S256`;

  res.writeHead(302, { Location: authUrl });
  res.end();
};
