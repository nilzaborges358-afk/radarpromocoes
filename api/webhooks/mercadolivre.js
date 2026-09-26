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
    await handlePromotionEvent(payload, marketplaceId, accessToken);
  }

  // orders_v2, questions, shipments: mesmo padrão — buscar o resource e
  // gravar no lugar apropriado. Deixado como próximo passo depois que o
  // fluxo de items/promoções estiver validado.
}

/**
 * Trata um evento de promoção da SUA loja e:
 * 1. grava/atualiza `ml_seller_metrics` (como já fazia);
 * 2. se a promoção parecer ativa, também cria uma linha em `promotions`,
 *    pra aparecer junto com as promoções de terceiros no mesmo painel.
 *
 * ATENÇÃO: o nome e os valores exatos do campo de status retornado por
 * `public_offers`/`public_candidates` (ex.: "active", "started"...) ainda não
 * foram confirmados na documentação pública. Assim que o primeiro evento real
 * chegar, confira o conteúdo em `webhook_events.raw_payload` no Supabase e
 * ajuste a lista `ACTIVE_STATUSES` abaixo se o valor vier diferente.
 */
const ACTIVE_STATUSES = ['active', 'started', 'approved'];

async function handlePromotionEvent(payload, marketplaceId, accessToken) {
  const detail = await authenticatedGet(payload.resource, accessToken);
  const itemId = detail.item_id;

  const { data: metricRow } = await supabaseAdmin
    .from('ml_seller_metrics')
    .upsert(
      {
        item_id: itemId,
        promotion_status: detail.status?.id || detail.status,
        promotion_type: detail.type,
        raw_payload: detail,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'item_id' }
    )
    .select()
    .single();

  const statusValue = String(detail.status?.id || detail.status || '').toLowerCase();
  if (!ACTIVE_STATUSES.includes(statusValue)) return; // promoção ainda não está ativa/aprovada

  let item;
  try {
    item = await authenticatedGet(`/items/${itemId}`, accessToken);
  } catch (err) {
    await supabaseAdmin.from('integration_logs').insert({
      marketplace_id: marketplaceId,
      level: 'warn',
      message: `Não consegui buscar detalhes do item ${itemId} para montar a promoção: ${err.message}`,
    });
    return;
  }

  // Evita duplicar a mesma promoção se o ML reenviar o webhook (retry).
  const { data: existing } = await supabaseAdmin
    .from('promotions')
    .select('id')
    .eq('ml_seller_metric_id', metricRow.id)
    .eq('current_price', item.price)
    .maybeSingle();

  if (existing) return;

  // `item.original_price` é o campo que o ML usa para o preço "de antes" quando
  // o item está em promoção — confirmar no primeiro payload real antes de confiar 100%.
  const previousPrice = item.original_price || null;
  const discountRate = previousPrice
    ? Number((((previousPrice - item.price) / previousPrice) * 100).toFixed(2))
    : null;

  await supabaseAdmin.from('promotions').insert({
    marketplace_id: marketplaceId,
    ml_seller_metric_id: metricRow.id,
    title: item.title,
    image_url: item.thumbnail,
    original_url: item.permalink,
    current_price: item.price,
    previous_price: previousPrice,
    discount_rate: discountRate,
    source: 'own_store_webhook',
    status: 'PENDING',
  });
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
