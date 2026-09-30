const { supabaseAdmin } = require('../../src/core/database/supabaseClient');

// GET  /api/credentials/shopee  -> status
// POST /api/credentials/shopee  -> { app_id, app_secret }
module.exports = async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      res.status(500).json({ error: 'Faltam SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY na Vercel.' });
      return;
    }

    const { data: marketplace, error: mpError } = await supabaseAdmin
      .from('marketplaces')
      .select('id')
      .eq('slug', 'shopee')
      .single();

    if (mpError || !marketplace) {
      res.status(500).json({
        error: `Não encontrei a Shopee na tabela marketplaces (${mpError?.message || 'sem resultado'}). Rode o SQL v9-shopee-marketplace.sql no Supabase.`,
      });
      return;
    }

    if (req.method === 'GET') {
      const { data: creds } = await supabaseAdmin
        .from('marketplace_credentials')
        .select('client_id')
        .eq('marketplace_id', marketplace.id)
        .maybeSingle();

      res.status(200).json({
        hasCredentials: Boolean(creds?.client_id),
        clientId: creds?.client_id || null,
      });
      return;
    }

    if (req.method === 'POST') {
      const { app_id, app_secret } = req.body || {};
      if (!app_id || !app_secret) {
        res.status(400).json({ error: 'app_id e app_secret são obrigatórios.' });
        return;
      }

      // Reaproveita as colunas client_id/client_secret (mesmo nome usado pro Mercado Livre).
      const { error } = await supabaseAdmin.from('marketplace_credentials').upsert(
        {
          marketplace_id: marketplace.id,
          client_id: app_id,
          client_secret: app_secret,
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
