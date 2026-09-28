// GET  /api/credentials/mercadolivre  -> status (nunca devolve secrets)
// POST /api/credentials/mercadolivre  -> { client_id, client_secret }
//
// ATENÇÃO: assim como o resto do painel, este endpoint ainda não tem
// autenticação — qualquer pessoa com a URL do site consegue chamar o POST.
// Aceitável só enquanto o uso é pessoal; antes de compartilhar a URL,
// isso precisa de uma camada de login (Supabase Auth).
module.exports = async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      res.status(500).json({
        error:
          'Faltam as variáveis SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY na Vercel (Settings > Environment Variables). Depois de adicionar, faça um Redeploy.',
      });
      return;
    }

    // require dentro do try para o erro aparecer como mensagem, e não como página de erro da Vercel
    const { supabaseAdmin } = require('../../src/core/database/supabaseClient');

    const { data: marketplace, error: mpError } = await supabaseAdmin
      .from('marketplaces')
      .select('id')
      .eq('slug', 'mercadolivre')
      .single();

    if (mpError || !marketplace) {
      res.status(500).json({
        error: `Não encontrei o Mercado Livre na tabela marketplaces do Supabase (${mpError?.message || 'sem resultado'}). Confirme que o SQL do schema foi rodado por completo.`,
      });
      return;
    }

    if (req.method === 'GET') {
      const { data: creds, error } = await supabaseAdmin
        .from('marketplace_credentials')
        .select('client_id, access_token, seller_id')
        .eq('marketplace_id', marketplace.id)
        .maybeSingle();

      if (error) throw new Error(error.message);

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

      const { error } = await supabaseAdmin.from('marketplace_credentials').upsert(
        {
          marketplace_id: marketplace.id,
          client_id,
          client_secret,
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
