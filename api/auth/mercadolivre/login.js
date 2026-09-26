// GET /api/auth/mercadolivre/login
// Abra esta URL no navegador (logado com sua conta de vendedor no ML) para autorizar o app.
module.exports = function handler(req, res) {
  const clientId = process.env.MERCADOLIVRE_CLIENT_ID;
  const redirectUri = process.env.MERCADOLIVRE_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    res.status(500).send('MERCADOLIVRE_CLIENT_ID / MERCADOLIVRE_REDIRECT_URI não configurados.');
    return;
  }

  const authUrl =
    `https://auth.mercadolivre.com.br/authorization` +
    `?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.writeHead(302, { Location: authUrl });
  res.end();
};
