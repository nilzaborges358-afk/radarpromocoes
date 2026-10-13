const { supabaseAdmin } = require('../src/core/database/supabaseClient');

// Trava de segurança do disparador — evita spam e problema com a plataforma.
const FRESH_DAYS = 3;            // só envia promoção que a busca ainda viu nos últimos 3 dias
const NO_REPEAT_DAYS = 14;       // não repete a mesma promoção no mesmo destino por 14 dias
const RETRY_FAILED_HOURS = 6;    // promoção que falhou ao enviar só é tentada de novo depois disso
const MIN_SPACING_SECONDS = 90;  // Telegram: bloqueia dois envios colados (duplo clique, duas abas)
const MAX_DAILY_LIMIT = 200;

const OPENERS = ['🔥 OLHA ESSA OFERTA!', '🎯 Achado do dia:', '⚡ Promoção boa de aproveitar:', '👀 Vale a pena ver isso:'];

// POST /api/dispatch  { action, ... }
//   GET                                       -> lista destinos
//   create_destination { name, platform, chat_id, bot_token, daily_limit }
//   delete_destination { id }
//   test               { destination_id }
//   queue              { destination_id, group_ids, marketplace }
//   send_next          { destination_id, group_ids, marketplace, footer }
module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') return await listDestinations(res);

    if (req.method === 'POST') {
      const body = req.body || {};
      switch (body.action) {
        case 'create_destination': return await createDestination(res, body);
        case 'delete_destination': return await deleteDestination(res, body);
        case 'test': return await testDestination(res, body);
        case 'queue': return await queueInfo(res, body);
        case 'send_next': return await sendNext(res, body);
        default:
          res.status(400).json({ error: 'Ação desconhecida.' });
          return;
      }
    }

    res.status(405).json({ error: 'Método não permitido.' });
  } catch (err) {
    res.status(500).json({ error: `Erro no servidor: ${err.message}` });
  }
};

// ---------------- Telegram ----------------

async function telegramCall(token, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const err = new Error(data.description || `Telegram respondeu ${res.status}`);
    err.retryAfter = data.parameters && data.parameters.retry_after;
    throw err;
  }
  return data.result;
}

function telegramHint(message) {
  if (/chat not found/i.test(message)) {
    return `${message} (o bot precisa ser membro do grupo ou administrador do canal; para canal use @nome_do_canal)`;
  }
  if (/not enough rights|have no rights|forbidden/i.test(message)) {
    return `${message} (dê permissão de enviar mensagens ao bot no grupo/canal)`;
  }
  return message;
}

async function sendTelegram(dest, promo, message) {
  if (promo.image_url) {
    try {
      await telegramCall(dest.bot_token, 'sendPhoto', { chat_id: dest.chat_id, photo: promo.image_url, caption: message });
      return;
    } catch (err) {
      if (err.retryAfter) throw err; // limite de envio: não adianta cair pro texto
      // imagem recusada pelo Telegram: segue só com o texto
    }
  }
  await telegramCall(dest.bot_token, 'sendMessage', { chat_id: dest.chat_id, text: message });
}

// ---------------- Mensagem ----------------

function money(v) {
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
}

function buildMessage(promo, footer) {
  const opener = OPENERS[Math.floor(Math.random() * OPENERS.length)];
  const price = promo.previous_price
    ? `De R$ ${money(promo.previous_price)} por R$ ${money(promo.current_price)}${promo.discount_rate ? ` (${Math.round(promo.discount_rate)}% OFF)` : ''}`
    : `Por R$ ${money(promo.current_price)}`;
  const lines = [opener, '', String(promo.title).slice(0, 200), '', price, '', `👉 ${promo.affiliate_url}`];
  if (footer) lines.push('', String(footer).slice(0, 120));
  return lines.join('\n');
}

// ---------------- Destinos ----------------

async function getDestination(id) {
  if (!id) return null;
  const { data } = await supabaseAdmin.from('send_destinations').select('*').eq('id', id).maybeSingle();
  return data;
}

async function sentInLast24h(destinationId) {
  const since = new Date(Date.now() - 864e5).toISOString();
  const { count } = await supabaseAdmin
    .from('send_log')
    .select('id', { count: 'exact', head: true })
    .eq('destination_id', destinationId)
    .eq('status', 'sent')
    .gte('sent_at', since);
  return count || 0;
}

async function listDestinations(res) {
  // O token do bot NÃO é selecionado aqui — nunca sai do servidor.
  const { data, error } = await supabaseAdmin
    .from('send_destinations')
    .select('id, name, platform, chat_id, daily_limit, created_at')
    .order('created_at');
  if (error) throw new Error(error.message);

  const destinations = [];
  for (const d of data || []) {
    destinations.push({ ...d, sentLast24h: await sentInLast24h(d.id) });
  }
  res.status(200).json({ destinations });
}

async function createDestination(res, body) {
  const name = (body.name || '').trim();
  const platform = body.platform || 'telegram';
  const dailyLimit = Math.min(Math.max(parseInt(body.daily_limit, 10) || 60, 1), MAX_DAILY_LIMIT);

  if (!name) {
    res.status(400).json({ error: 'Dê um nome ao destino.' });
    return;
  }

  if (platform === 'telegram') {
    const chatId = (body.chat_id || '').trim();
    const token = (body.bot_token || '').trim();
    if (!chatId || !token) {
      res.status(400).json({ error: 'Informe o token do bot e o chat do Telegram.' });
      return;
    }

    let me;
    try {
      me = await telegramCall(token, 'getMe');
    } catch (err) {
      res.status(400).json({ error: `O Telegram não aceitou esse token: ${err.message}` });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('send_destinations')
      .insert({ name, platform, chat_id: chatId, bot_token: token, daily_limit: dailyLimit })
      .select('id, name')
      .single();
    if (error) throw new Error(error.message);
    res.status(200).json({ ok: true, destination: data, botUsername: me.username });
    return;
  }

  if (platform === 'whatsapp_manual') {
    const { data, error } = await supabaseAdmin
      .from('send_destinations')
      .insert({ name, platform, daily_limit: dailyLimit })
      .select('id, name')
      .single();
    if (error) throw new Error(error.message);
    res.status(200).json({ ok: true, destination: data });
    return;
  }

  res.status(400).json({ error: 'Plataforma não suportada.' });
}

async function deleteDestination(res, body) {
  if (!body.id) {
    res.status(400).json({ error: 'id é obrigatório.' });
    return;
  }
  await supabaseAdmin.from('send_destinations').delete().eq('id', body.id);
  res.status(200).json({ ok: true });
}

async function testDestination(res, body) {
  const dest = await getDestination(body.destination_id);
  if (!dest) {
    res.status(404).json({ error: 'Destino não encontrado.' });
    return;
  }
  const text = '✅ Teste do Radar: se você está lendo isso, o envio está conectado.';

  if (dest.platform === 'whatsapp_manual') {
    res.status(200).json({ ok: true, manual: true, message: text });
    return;
  }

  try {
    await telegramCall(dest.bot_token, 'sendMessage', { chat_id: dest.chat_id, text });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: `Falha no teste: ${telegramHint(err.message)}` });
  }
}

// ---------------- Fila ----------------

async function pickQueue(dest, { group_ids, marketplace }) {
  const cutoff = new Date(Date.now() - FRESH_DAYS * 864e5).toISOString();

  // Só entra na fila promoção COM link de afiliado, não ignorada e vista recentemente.
  const { data: candidates, error } = await supabaseAdmin
    .from('promotions')
    .select('id, title, image_url, original_url, affiliate_url, current_price, previous_price, discount_rate, watch_group_id, marketplaces(slug, name)')
    .not('affiliate_url', 'is', null)
    .neq('status', 'IGNORED')
    .gte('last_seen_at', cutoff)
    .order('discount_rate', { ascending: false, nullsFirst: false })
    .limit(400);
  if (error) throw new Error(error.message);

  const repeatSince = new Date(Date.now() - NO_REPEAT_DAYS * 864e5).toISOString();
  const { data: history } = await supabaseAdmin
    .from('send_log')
    .select('promotion_id, status, sent_at')
    .eq('destination_id', dest.id)
    .gte('sent_at', repeatSince);

  const retryAfter = Date.now() - RETRY_FAILED_HOURS * 36e5;
  const blocked = new Set();
  for (const h of history || []) {
    if (h.status === 'sent' || new Date(h.sent_at).getTime() > retryAfter) blocked.add(h.promotion_id);
  }

  const groupSet = Array.isArray(group_ids) && group_ids.length ? new Set(group_ids) : null;

  return (candidates || []).filter(
    (p) =>
      !blocked.has(p.id) &&
      (!groupSet || groupSet.has(p.watch_group_id || 'none')) &&
      (!marketplace || (p.marketplaces && p.marketplaces.slug === marketplace))
  );
}

async function queueInfo(res, body) {
  const dest = await getDestination(body.destination_id);
  if (!dest) {
    res.status(404).json({ error: 'Destino não encontrado.' });
    return;
  }
  const queue = await pickQueue(dest, body);
  const next = queue[0];
  res.status(200).json({
    ok: true,
    count: queue.length,
    next: next
      ? { title: next.title, price: next.current_price, discount: next.discount_rate, marketplace: next.marketplaces && next.marketplaces.name }
      : null,
  });
}

async function logSend(destinationId, promotionId, status, errorText) {
  await supabaseAdmin
    .from('send_log')
    .insert({ destination_id: destinationId, promotion_id: promotionId, status, error: errorText || null });
}

async function sendNext(res, body) {
  const dest = await getDestination(body.destination_id);
  if (!dest) {
    res.status(404).json({ error: 'Destino não encontrado.' });
    return;
  }

  // Limite diário (últimas 24h)
  const sent24 = await sentInLast24h(dest.id);
  if (sent24 >= dest.daily_limit) {
    res.status(429).json({ error: `Limite de ${dest.daily_limit} envios nas últimas 24h atingido para "${dest.name}".`, code: 'daily_limit' });
    return;
  }

  // Espaçamento mínimo (só Telegram) — protege contra duplo clique e duas abas abertas
  if (dest.platform === 'telegram') {
    const { data: last } = await supabaseAdmin
      .from('send_log')
      .select('sent_at')
      .eq('destination_id', dest.id)
      .eq('status', 'sent')
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last && Date.now() - new Date(last.sent_at).getTime() < MIN_SPACING_SECONDS * 1000) {
      res.status(429).json({ error: 'Envio muito próximo do anterior (confira se não há outra aba do Disparador aberta).', code: 'too_fast' });
      return;
    }
  }

  const queue = await pickQueue(dest, body);
  if (!queue.length) {
    res.status(200).json({ ok: true, empty: true });
    return;
  }

  const promo = queue[0];
  const message = buildMessage(promo, body.footer);

  if (dest.platform === 'whatsapp_manual') {
    await logSend(dest.id, promo.id, 'sent');
    res.status(200).json({
      ok: true,
      manual: true,
      message,
      promotion: { id: promo.id, title: promo.title },
      remaining: queue.length - 1,
    });
    return;
  }

  try {
    await sendTelegram(dest, promo, message);
    await logSend(dest.id, promo.id, 'sent');
    res.status(200).json({
      ok: true,
      sent: { id: promo.id, title: promo.title, marketplace: promo.marketplaces && promo.marketplaces.name },
      remaining: queue.length - 1,
    });
  } catch (err) {
    await logSend(dest.id, promo.id, 'failed', err.message);
    if (err.retryAfter) {
      res.status(429).json({ error: `O Telegram pediu para esperar ${err.retryAfter}s.`, code: 'rate_limited', retryAfter: err.retryAfter });
    } else {
      res.status(502).json({ error: `Falha ao enviar pelo Telegram: ${telegramHint(err.message)}`, code: 'send_failed' });
    }
  }
}
