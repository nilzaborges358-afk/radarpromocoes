const { supabaseAdmin } = require('../../src/core/database/supabaseClient');

// GET  /api/credentials/mercadolivre  -> status (nunca devolve secrets)
// POST /api/credentials/mercadolivre  -> { client_id, client_secret }
//
// ATENÇÃO: assim como o resto do painel, este endpoint ainda não tem
// autenticação — qualquer pessoa com a URL do site consegue chamar o POST.
// Aceitável só enquanto o uso é pessoal; antes de compartilhar a URL,
// isso precisa de uma camada de login (Supabase Auth).
module.exports = async function handler(req, res) {
  const { data: marketplace } = await supabaseAdmin
    .from('marketplaces')
    .select('id')
    .eq('slug', 'mercadolivre')
    .single();

  if (req.method === 'GET') {
    const { data: creds } = await supabaseAdmin
      .from('marketplace_credentials')
      .select('client_id, access_token, seller_id')
      .eq('marketplace_id', marketplace.id)
      .maybeSingle();

    res.status(200).json({
      hasCredentials: Boolean(creds?.client_id),
      hasAccessToken: Boolean(creds?.access_token),
      sellerId: creds?.seller_id || null,
      clientId: creds?.client_id || null, // client_id não é secreto, ok mostrar
    });
    return;
  }

  if (req.method === 'POST') {
    const { client_id, client_secret } = req.body || {};
    if (!client_id || !client_secret) {
      res.status(400).json({ error: 'client_id e client_secret são obrigatórios.' });
      return;
    }

    await supabaseAdmin.from('marketplace_credentials').upsert(
      {
        marketplace_id: marketplace.id,
        client_id,
        client_secret,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'marketplace_id' }
    );

    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).end();
};
