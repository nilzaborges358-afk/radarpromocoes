const crypto = require('crypto');
const { exchangeCodeForToken } = require('../../src/integrations/mercadolivre/client');
const { supabaseAdmin } = require('../../src/core/database/supabaseClient');

// GET /api/auth/mercadolivre            -> inicia o login (redireciona pro Mercado Livre)
// GET /api/auth/mercadolivre?code=...   -> callback do OAuth (o Mercado Livre chama esta mesma URL)
// Antes eram dois arquivos (login.js e callback.js) — juntei pra economizar
// uma Serverless Function (plano Hobby da Vercel só libera 12 no total).
module.exports = async function handler(req, res) {
  const { data: marketplace } = await supabaseAdmin
    .from('marketplaces')
    .select('id')
    .eq('slug', 'mercadolivre')
    .single();

  if (req.query.code) {
    return handleCallback(req, res, marketplace.id);
  }
  return handleLogin(req, res, marketplace.id);
};

async function handleLogin(req, res, marketplaceId) {
  const { data: creds } = await supabaseAdmin
    .from('marketplace_credentials')
    .select('client_id')
    .eq('marketplace_id', marketplaceId)
    .maybeSingle();

  if (!creds?.client_id) {
    res
      .status(400)
      .send('Nenhum Client ID cadastrado ainda. Vá em /marketplaces.html e salve suas credenciais do Mercado Livre primeiro.');
    return;
  }

  const codeVerifier = crypto.randomBytes(64).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  await supabaseAdmin
    .from('marketplace_credentials')
    .update({ pending_code_verifier: codeVerifier })
    .eq('marketplace_id', marketplaceId);

  const redirectUri = `https://${req.headers.host}/api/auth/mercadolivre`;

  const authUrl =
    `https://auth.mercadolivre.com.br/authorization` +
    `?response_type=code&client_id=${encodeURIComponent(creds.client_id)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}` +
    `&code_challenge_method=S256`;

  res.writeHead(302, { Location: authUrl });
  res.end();
}

async function handleCallback(req, res, marketplaceId) {
  try {
    const { data: creds } = await supabaseAdmin
      .from('marketplace_credentials')
      .select('client_id, client_secret, pending_code_verifier')
      .eq('marketplace_id', marketplaceId)
      .single();

    if (!creds?.client_id || !creds?.client_secret) {
      res.status(400).send('Credenciais não encontradas. Cadastre em /marketplaces.html antes de conectar.');
      return;
    }

    const redirectUri = `https://${req.headers.host}/api/auth/mercadolivre`;

    const token = await exchangeCodeForToken({
      code: req.query.code,
      clientId: creds.client_id,
      clientSecret: creds.client_secret,
      redirectUri,
      codeVerifier: creds.pending_code_verifier,
    });

    const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();

    await supabaseAdmin.from('marketplace_credentials').upsert(
      {
        marketplace_id: marketplaceId,
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        token_expires_at: expiresAt,
        seller_id: String(token.user_id),
        pending_code_verifier: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'marketplace_id' }
    );

    res.status(200).send('Conta do Mercado Livre conectada com sucesso. Pode fechar esta aba e voltar ao painel.');
  } catch (err) {
    res.status(500).send(`Erro ao conectar: ${err.message}`);
  }
}
