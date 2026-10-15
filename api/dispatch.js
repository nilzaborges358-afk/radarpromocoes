const { supabaseAdmin } = require('../src/core/database/supabaseClient');
const { getNetshoesContext, loadNetshoesCoupons, bestNetshoesCoupon } = require('../src/core/coupons');

// Disparador de promoções (Telegram automático / WhatsApp assistido).
// GET  /api/dispatch                      -> lista destinos
// POST /api/dispatch { action: ... }      -> create_destination | delete_destination | test | queue | send_next
// Precisa das tabelas dispatch_destinations e dispatch_log (SQL em supabase/migrations/0002_disparador.sql).

const QUEUE_DAYS_SEEN = 3;     // só promoções vistas pela busca nos últimos 3 dias
const NO_REPEAT_DAYS = 14;     // não repete a mesma promoção no mesmo destino por 2 semanas
const MIN_GAP_SECONDS = 20;    // trava anti-duplo-clique
const COUPON_CACHE_MS = 10 * 60 * 1000;
let couponCache = { at: 0, list: null };

// ---------------- utilitários ----------------

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n) => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

function fail(res, status, error, extra) {
  res.status(status).json({ error, ...(extra || {}) });
}

function tableMissing(error) {
  const m = String((error && (error.message || error)) || '');
  return (error && error.code === '42P01') || /does not exist|schema cache|relation .* not found/i.test(m);
}

function dbError(error) {
  if (tableMissing(error)) {
    return 'As tabelas do disparador ainda não existem no Supabase. Rode o SQL do arquivo 0002_disparador.sql (SQL Editor > New query) e tente de novo.';
  }
  return `banco de dados: ${error.message || error}`;
}

async function telegram(token, method, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: ctrl.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!data.ok) {
      const err = new Error(data.description || `Telegram respondeu ${r.status}`);
      err.status = data.error_code || r.status;
      err.retryAfter = data.parameters && data.parameters.retry_after;
      throw err;
    }
    return data.result;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('O Telegram demorou demais para responder.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function friendlyTelegramError(err) {
  const m = String(err.message || '');
  if (/unauthorized|not found/i.test(m) && err.status === 401) return 'Token do bot inválido. Copie de novo no @BotFather.';
  if (/chat not found/i.test(m)) return 'Chat não encontrado. Confira o @canal (ou id) e se o bot foi adicionado ao canal/grupo.';
  if (/not enough rights|have no rights|administrator|forbidden/i.test(m)) return 'O bot não tem permissão para postar. Em canal, torne o bot administrador com permissão de postar.';
  return m;
}

// ---------------- mensagens (várias variações) ----------------

const OPENERS = ['🔥', '💥', '⚡', '🚨', '🛒', '😍', '🤑', '👀'];

function pick(arr, n) { return arr[Math.abs(n) % arr.length]; }

// Monta o texto. "turn" gira entre os modelos, então duas mensagens seguidas nunca saem iguais.
function buildMessage(p, turn, footer) {
  const emoji = pick(OPENERS, turn + p.title.length);
  const title = esc(p.title);
  const link = esc(p.affiliate_url);
  const { price, listPrice, coupon, finalPrice } = p.view;
  const off = p.view.discount ? Math.round(p.view.discount) : null;

  // linhas de preço
  const deLine = listPrice && listPrice > price ? `De <s>R$ ${money(listPrice)}</s> por <b>R$ ${money(price)}</b>` : `<b>R$ ${money(price)}</b>`;
  const couponLine = coupon ? `🎟️ Cupom <b>${esc(coupon)}</b>: fica <b>R$ ${money(finalPrice)}</b>` : null;
  const offTxt = off ? ` (${off}% OFF)` : '';
  const shortPrice = coupon ? `R$ ${money(finalPrice)} com o cupom ${esc(coupon)}` : `R$ ${money(price)}`;

  const templates = [
    // 0
    () => [`${emoji} <b>ACHADINHO!</b>`, '', title, '', deLine + offTxt, couponLine, '', `👉 ${link}`],
    // 1
    () => [`${emoji} Olha esse preço: <b>${shortPrice}</b>${offTxt}`, '', title, couponLine && listPrice ? `Antes: <s>R$ ${money(listPrice)}</s>` : (listPrice && listPrice > price ? `Antes: <s>R$ ${money(listPrice)}</s>` : null), '', `Garanta aqui 👇`, link],
    // 2
    () => [`🛍️ <b>Promoção no ar</b>`, title, '', deLine, couponLine, off ? `📉 ${off}% de desconto` : null, '', `🔗 ${link}`],
    // 3
    () => [`${emoji} Corre que pode acabar!`, '', `<b>${title}</b>`, `💰 ${shortPrice}${listPrice && listPrice > price ? ` (era R$ ${money(listPrice)})` : ''}`, '', `Comprar: ${link}`],
    // 4
    () => [`✅ <b>Achado do dia</b>`, '', title, '', couponLine ? `Preço na loja: R$ ${money(price)}` : deLine + offTxt, couponLine, '', `👉 Pegue pelo link: ${link}`],
    // 5
    () => [`${emoji} <b>Tá barato!</b> ${off ? `${off}% OFF` : ''}`.trim(), title, '', `${listPrice && listPrice > price ? `<s>R$ ${money(listPrice)}</s> → ` : ''}<b>R$ ${money(couponLine ? finalPrice : price)}</b>${coupon ? ` (cupom ${esc(coupon)})` : ''}`, '', `🛒 ${link}`],
  ];

  const lines = templates[Math.abs(turn) % templates.length]().filter((l) => l !== null && l !== undefined);
  // limpa linhas em branco repetidas
  const cleaned = [];
  for (const l of lines) { if (l === '' && (cleaned.length === 0 || cleaned[cleaned.length - 1] === '')) continue; cleaned.push(l); }
  if (footer) cleaned.push('', esc(footer));
  return cleaned.join('\n');
}

// Versão sem HTML para o WhatsApp (que não entende <b>/<s>).
function toPlain(html) {
  return html.replace(/<\/?(b|s)>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// ---------------- fila ----------------

async function getDestination(id) {
  const { data, error } = await supabaseAdmin.from('dispatch_destinations').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(dbError(error));
  return data;
}

async function loadQueue(destId, body) {
  const groupIds = Array.isArray(body.group_ids) ? body.group_ids : [];
  const since = isoAgo(QUEUE_DAYS_SEEN * DAY);

  let q = supabaseAdmin
    .from('promotions')
    .select('id, title, image_url, original_url, current_price, previous_price, discount_rate, source, status, affiliate_url, watch_group_id, last_seen_at, detected_at, marketplaces(slug, name)')
    .not('affiliate_url', 'is', null)
    .neq('status', 'IGNORED')
    .gt('current_price', 0)
    .or(`last_seen_at.gte.${since},and(last_seen_at.is.null,detected_at.gte.${since})`)
    .order('discount_rate', { ascending: false, nullsFirst: false })
    .limit(600);
  const { data, error } = await q;
  if (error) throw new Error(dbError(error));

  const { data: logs, error: logErr } = await supabaseAdmin
    .from('dispatch_log').select('promotion_id').eq('destination_id', destId).gte('sent_at', isoAgo(NO_REPEAT_DAYS * DAY));
  if (logErr) throw new Error(dbError(logErr));
  const already = new Set((logs || []).map((l) => l.promotion_id));

  const wantNone = groupIds.includes('none');
  const mp = body.marketplace || null;

  return (data || []).filter((p) => {
    if (already.has(p.id)) return false;
    if (!/^https?:\/\//i.test(p.affiliate_url || '')) return false;
    if (mp && (!p.marketplaces || p.marketplaces.slug !== mp)) return false;
    if (groupIds.length) {
      if (p.watch_group_id) { if (!groupIds.includes(p.watch_group_id)) return false; }
      else if (!wantNone) return false;
    }
    return true;
  });
}

async function netshoesCoupons() {
  if (couponCache.list && Date.now() - couponCache.at < COUPON_CACHE_MS) return couponCache.list;
  try {
    const ctx = await getNetshoesContext(supabaseAdmin);
    if (ctx.error) return null;
    const loaded = await loadNetshoesCoupons(ctx);
    if (loaded.error) return null;
    couponCache = { at: Date.now(), list: loaded.coupons || [] };
    return couponCache.list;
  } catch { return null; }
}

// Calcula o que vai aparecer na mensagem. Retorna null se a promoção não vale mais (ex.: cupom venceu).
async function buildView(p) {
  const slug = p.marketplaces && p.marketplaces.slug;
  let price = Number(p.current_price);
  let listPrice = p.previous_price ? Number(p.previous_price) : null;
  let coupon = null; let finalPrice = null;

  if (slug === 'netshoes') {
    const fromCoupon = p.source === 'netshoes_coupon';
    // Em ofertas por cupom, current_price já é o preço COM cupom e previous_price é o preço da loja.
    const storePrice = fromCoupon ? Number(p.previous_price) : price;
    const list = await netshoesCoupons();
    const best = list && storePrice > 0 ? bestNetshoesCoupon(list, { title: p.title, price: storePrice, category: null }) : null;
    if (best) {
      coupon = best.coupon.code; finalPrice = r2(best.finalPrice); price = r2(storePrice);
      listPrice = fromCoupon ? null : listPrice;
    } else if (fromCoupon) {
      return null; // a oferta dependia de um cupom que não consigo confirmar agora
    }
  }

  const base = coupon ? finalPrice : price;
  const ref = listPrice && listPrice > price ? listPrice : (coupon ? price : null);
  const discount = ref && base < ref ? ((ref - base) / ref) * 100 : (p.discount_rate ? Number(p.discount_rate) : null);
  return { price: r2(price), listPrice: listPrice ? r2(listPrice) : null, coupon, finalPrice, discount };
}

// ---------------- ações ----------------

async function createDestination(res, body) {
  const platform = body.platform === 'whatsapp_manual' ? 'whatsapp_manual' : 'telegram';
  const name = String(body.name || '').replace(/\s+/g, ' ').trim();
  if (!name) return fail(res, 400, 'Dê um nome ao destino (ex.: Achadinhos).');
  const dailyLimit = Math.min(Math.max(parseInt(body.daily_limit, 10) || 60, 1), 200);

  const row = { name: name.slice(0, 80), platform, daily_limit: dailyLimit, chat_id: null, bot_token: null };
  let botUsername = null;

  if (platform === 'telegram') {
    const chat = String(body.chat_id || '').trim();
    const token = String(body.bot_token || '').trim();
    if (!chat) return fail(res, 400, 'Preencha o Chat (@nome_do_canal ou o id numérico).');
    if (!/^\d+:[\w-]{20,}$/.test(token)) return fail(res, 400, 'Token do bot com formato estranho. Ele parece com 123456789:ABCdef... (copie inteiro do @BotFather).');
    try { botUsername = (await telegram(token, 'getMe')).username; }
    catch (err) { return fail(res, 400, friendlyTelegramError(err)); }
    row.chat_id = /^-?\d+$/.test(chat) || chat.startsWith('@') ? chat : `@${chat}`;
    row.bot_token = token;
  }

  const { error } = await supabaseAdmin.from('dispatch_destinations').insert(row);
  if (error) return fail(res, 500, dbError(error));
  res.status(200).json({ ok: true, botUsername });
}

async function listDestinations(res) {
  const { data, error } = await supabaseAdmin.from('dispatch_destinations').select('id, name, platform, chat_id, daily_limit, created_at').order('created_at');
  if (error) return fail(res, 500, dbError(error));
  const since = isoAgo(DAY);
  const out = [];
  for (const d of data || []) {
    const { count } = await supabaseAdmin.from('dispatch_log').select('id', { count: 'exact', head: true })
      .eq('destination_id', d.id).eq('skipped', false).gte('sent_at', since);
    out.push({ ...d, sentLast24h: count || 0 });
  }
  res.status(200).json({ destinations: out });
}

async function sendTest(res, body) {
  const dest = await getDestination(body.destination_id);
  if (!dest) return fail(res, 404, 'Destino não encontrado.');
  const text = '✅ Teste do Radar de Promoções: se você está lendo isso, o destino está funcionando.';
  if (dest.platform === 'whatsapp_manual') return res.status(200).json({ ok: true, manual: true, message: text });
  try { await telegram(dest.bot_token, 'sendMessage', { chat_id: dest.chat_id, text }); }
  catch (err) { return fail(res, 400, friendlyTelegramError(err)); }
  res.status(200).json({ ok: true });
}

async function queue(res, body) {
  const dest = await getDestination(body.destination_id);
  if (!dest) return fail(res, 404, 'Destino não encontrado.');
  const list = await loadQueue(dest.id, body);
  if (!list.length) return res.status(200).json({ count: 0 });
  const n = list[0];
  res.status(200).json({
    count: list.length,
    next: { title: n.title, price: Number(n.current_price), discount: n.discount_rate ? Number(n.discount_rate) : null, marketplace: n.marketplaces ? n.marketplaces.name : null },
  });
}

async function sendNext(res, body) {
  const dest = await getDestination(body.destination_id);
  if (!dest) return fail(res, 404, 'Destino não encontrado.');

  // limite diário e trava anti-duplo-clique
  const { count: sent24 } = await supabaseAdmin.from('dispatch_log').select('id', { count: 'exact', head: true })
    .eq('destination_id', dest.id).eq('skipped', false).gte('sent_at', isoAgo(DAY));
  if ((sent24 || 0) >= dest.daily_limit) return fail(res, 429, `Limite de ${dest.daily_limit} envios em 24h atingido para "${dest.name}".`, { code: 'daily_limit' });

  const { data: last } = await supabaseAdmin.from('dispatch_log').select('sent_at').eq('destination_id', dest.id).eq('skipped', false)
    .order('sent_at', { ascending: false }).limit(1);
  if (last && last[0] && Date.now() - new Date(last[0].sent_at).getTime() < MIN_GAP_SECONDS * 1000) {
    return fail(res, 429, 'Envio muito rápido, aguardando alguns segundos.', { code: 'too_fast' });
  }

  const list = await loadQueue(dest.id, body);
  let chosen = null; let view = null; let tries = 0;
  for (const p of list) {
    if (tries >= 8) break;
    tries += 1;
    const v = await buildView(p);
    if (v) { chosen = p; view = v; break; }
    // oferta que não vale mais: registra como pulada para não ficar travando a fila
    await supabaseAdmin.from('dispatch_log').insert({ destination_id: dest.id, promotion_id: p.id, skipped: true, message: 'pulada: cupom não confirmado' });
  }
  if (!chosen) return res.status(200).json({ empty: true });

  chosen.view = view;
  const { count: total } = await supabaseAdmin.from('dispatch_log').select('id', { count: 'exact', head: true }).eq('destination_id', dest.id);
  const html = buildMessage(chosen, total || 0, String(body.footer || '').slice(0, 120));
  const remaining = Math.max(list.length - tries, 0);
  const slugName = chosen.marketplaces ? chosen.marketplaces.name : null;

  if (dest.platform === 'whatsapp_manual') {
    const plain = toPlain(html);
    await supabaseAdmin.from('dispatch_log').insert({ destination_id: dest.id, promotion_id: chosen.id, skipped: false, message: plain });
    return res.status(200).json({ ok: true, manual: true, message: plain, promotion: { title: chosen.title, coupon: view.coupon }, remaining });
  }

  try {
    let done = false;
    if (chosen.image_url && /^https:\/\//i.test(chosen.image_url) && html.length <= 1000) {
      try {
        await telegram(dest.bot_token, 'sendPhoto', { chat_id: dest.chat_id, photo: chosen.image_url, caption: html, parse_mode: 'HTML' });
        done = true;
      } catch (e) { if (e.status === 429) throw e; /* imagem recusada: manda só o texto */ }
    }
    if (!done) await telegram(dest.bot_token, 'sendMessage', { chat_id: dest.chat_id, text: html, parse_mode: 'HTML', disable_web_page_preview: false });
  } catch (err) {
    if (err.status === 429) return fail(res, 429, 'Telegram pediu para ir mais devagar.', { code: 'rate_limited', retryAfter: err.retryAfter || 60 });
    return fail(res, 502, friendlyTelegramError(err));
  }

  await supabaseAdmin.from('dispatch_log').insert({ destination_id: dest.id, promotion_id: chosen.id, skipped: false, message: toPlain(html) });
  res.status(200).json({ ok: true, sent: { title: chosen.title, marketplace: slugName, coupon: view.coupon }, remaining });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') return await listDestinations(res);
    if (req.method !== 'POST') return fail(res, 405, 'Método não permitido.');

    const body = req.body || {};
    switch (body.action) {
      case 'create_destination': return await createDestination(res, body);
      case 'delete_destination': {
        const { error } = await supabaseAdmin.from('dispatch_destinations').delete().eq('id', body.id);
        if (error) return fail(res, 500, dbError(error));
        return res.status(200).json({ ok: true });
      }
      case 'test': return await sendTest(res, body);
      case 'queue': return await queue(res, body);
      case 'send_next': return await sendNext(res, body);
      default: return fail(res, 400, 'Ação inválida.');
    }
  } catch (err) {
    console.error('dispatch error', err);
    fail(res, 500, err.message || 'Erro inesperado no disparador.');
  }
};
