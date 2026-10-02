const crypto = require('crypto');

// POST   /api/auth/session -> { password }  (login no painel)
// DELETE /api/auth/session                  (logout)
module.exports = async function handler(req, res) {
  if (req.method === 'POST') {
    if (!process.env.PANEL_PASSWORD || !process.env.SESSION_SECRET) {
      res.status(500).json({ error: 'PANEL_PASSWORD e/ou SESSION_SECRET não configurados na Vercel.' });
      return;
    }

    const { password } = req.body || {};
    if (password !== process.env.PANEL_PASSWORD) {
      res.status(401).json({ error: 'Senha incorreta.' });
      return;
    }

    const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30 dias
    const payload = String(exp);
    const signature = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('hex');
    const token = `${payload}.${signature}`;

    res.setHeader('Set-Cookie', `radar_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', 'radar_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'Método não permitido.' });
};
