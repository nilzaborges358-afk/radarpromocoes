const { authenticatedGet, refreshAccessToken } = require('../../src/integrations/mercadolivre/client');
const { supabaseAdmin } = require('../../src/core/database/supabaseClient');

// POST /api/webhooks/mercadolivre
// Configure esta URL como "Notifications Callback URL" no seu app do ML,
// marcando os tópicos: orders_v2, items, public_offers, public_candidates.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const payload = req.body; // { topic, resource, user_id, application_id, ... }

  const { data: marketplace } = await supabaseAdmin
    .from('marketplaces')
    .select('id')
    .eq('slug', 'mercadolivre')
    .single();

  // 1. Sempre grava o evento bruto primeiro (auditoria/reprocessamento).
  const { data: eventRow } = await supabaseAdmin
    .from('webhook_events')
    .insert({
      marketplace_id: marketplace.id,
      topic: payload.topic,
      resource: payload.resource,
      raw_payload: payload,
    })
    .select()
    .single();

  // Responde 200 rápido — o ML espera resposta em poucos segundos.
  res.status(200).send('OK');

  // 2. Processa de forma assíncrona (o platform mantém a function viva até terminar).
  try {
    await processEvent(payload, marketplace.id);
    await supabaseAdmin
      .from('webhook_events')
      .update({ processed: true, processed_at: new Date().toISOString() })
      .eq('id', eventRow.id);
  } catch (err) {
    await supabaseAdmin
      .from('webhook_events')
      .update({ error: err.message })
      .eq('id', eventRow.id);
  }
};

async function processEvent(payload, marketplaceId) {
  const { data: creds } = await supabaseAdmin
    .from('marketplace_credentials')
    .select('*')
    .eq('marketplace_id', marketplaceId)
    .single();

  if (!creds) throw new Error('Nenhuma credencial do Mercado Livre cadastrada ainda.');

  const accessToken = await getFreshAccessToken(creds);

  if (payload.topic === 'items') {
    const item = await authenticatedGet(payload.resource, accessToken);
    await supabaseAdmin.from('ml_seller_metrics').upsert(
      {
        item_id: item.id,
        title: item.title,
        status: item.status,
        price: item.price,
        available_quantity: item.available_quantity,
        sold_quantity: item.sold_quantity,
        raw_payload: item,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'item_id' }
    );
  }

  if (payload.topic === 'public_offers' || payload.topic === 'public_candidates') {
    const detail = await authenticatedGet(payload.resource, accessToken);
    await supabaseAdmin.from('ml_seller_metrics').upsert(
      {
        item_id: detail.item_id,
        promotion_status: detail.status?.id || detail.status,
        promotion_type: detail.type,
        raw_payload: detail,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'item_id' }
    );
  }

  // orders_v2, questions, shipments: mesmo padrão — buscar o resource e
  // gravar no lugar apropriado. Deixado como próximo passo depois que o
  // fluxo de items/promoções estiver validado.
}

async function getFreshAccessToken(creds) {
  const isExpired = new Date(creds.token_expires_at) <= new Date();
  if (!isExpired) return creds.access_token;

  const refreshed = await refreshAccessToken({
    clientId: creds.client_id,
    clientSecret: creds.client_secret,
    refreshToken: creds.refresh_token,
  });

  const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();

  await supabaseAdmin
    .from('marketplace_credentials')
    .update({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      token_expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', creds.id);

  return refreshed.access_token;
}
