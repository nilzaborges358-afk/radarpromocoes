const { supabaseAdmin } = require('../src/core/database/supabaseClient');
const { getNetshoesContext, loadNetshoesCoupons, bestNetshoesCoupon } = require('../src/core/coupons');
const { getProductOffer } = require('../src/integrations/shopee/client');

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

const OPENERS = ['🔥', '🛒', '👀', '💥', '⚡', '😍'];

function pick(arr, n) { return arr[Math.abs(n) % arr.length]; }

// Monta o texto. "turn" gira entre os modelos, então duas mensagens seguidas nunca saem iguais.
// Tom: quem está compartilhando achou uma oferta boa. Nada de aviso técnico/“link de afiliado” no texto.
function buildMessage(p, turn, footer) {
  const emoji = pick(OPENERS, turn + p.title.length);
  const title = esc(p.title);
  const link = esc(p.affiliate_url);
  const { price, listPrice, coupon, finalPrice } = p.view;
  const off = p.view.discount ? Math.round(p.view.discount) : null;
  const hasList = listPrice && listPrice > price;
  const now = coupon ? finalPrice : price;

  const priceLine = hasList
    ? `💰 De <s>R$ ${money(listPrice)}</s> por <b>R$ ${money(now)}</b>${off ? ` (${off}% OFF)` : ''}`
    : `💰 Por apenas <b>R$ ${money(now)}</b>${off ? ` (${off}% OFF)` : ''}`;
  const couponLine = coupon ? `🎟️ Use o cupom <b>${esc(coupon)}</b> no carrinho` : null;
  const storeLine = coupon ? `💳 Preço na loja: R$ ${money(price)}` : null;

  const templates = [
    () => [`${emoji} <b>Olha o que a gente encontrou!</b>`, '', title, '', priceLine, couponLine, '', `🛒 Aproveite: ${link}`],
    () => [`${emoji} <b>Oferta boa demais pra deixar passar</b>`, '', title, '', priceLine, couponLine, '', `👉 ${link}`],
    () => [`✅ <b>Separamos essa pra você</b>`, '', title, priceLine, storeLine, couponLine, '', `Garanta aqui 👇`, link],
    () => [`${emoji} <b>Achado do dia</b>`, title, '', priceLine, couponLine, '', `🛒 ${link}`],
    () => [`${emoji} <b>Preço bom apareceu!</b>`, '', title, '', priceLine, couponLine, '', `Corre ver: ${link}`],
    () => [`⭐ <b>Recomendação do dia</b>`, '', title, '', priceLine, couponLine, '', `👉 Confira aqui: ${link}`],
  ];

  const lines = templates[Math.abs(turn) % templates.length]().filter((l) => l !== null && l !== undefined);
  const cleaned = [];
  for (const l of lines) { if (l === '' && (cleaned.length === 0 || cleaned[cleaned.length - 1] === '')) continue; cleaned.push(l); }
  // Rodapé opcional — mas nunca deixa sair aviso de "afiliado".
  const safeFooter = footer && !/afiliad/i.test(footer) ? footer : '';
  if (safeFooter) cleaned.push('', esc(safeFooter));
  return cleaned.join('\n');
}

// Versão sem HTML para o WhatsApp (que não entende <b>/<s>).
function toPlain(html) {
  return html.replace(/<\/?(b|s)>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}


// ---------------- validação antes de enviar ----------------

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DEAD_RE = /o produto n[ãa]o existe|produto n[ãa]o encontrado|p[áa]gina n[ãa]o encontrada|produto indispon[íi]vel|product (does not exist|not found)/i;
const BADLINK_RE = /invalid publisher code|partnership status/i;

// Abre o link como um cliente abriria e procura sinais claros de problema.
// Só reprova quando o sinal é claro; se o site bloquear/der erro de rede, segue (inconclusivo).
async function checkLink(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9', Accept: 'text/html,*/*' } });
    if (r.status === 404 || r.status === 410) return { ok: false, kind: 'dead', reason: `a página do produto não existe mais (erro ${r.status})` };
    const text = (await r.text().catch(() => '')).slice(0, 40000);
    if (BADLINK_RE.test(text)) return { ok: false, kind: 'badlink', reason: 'a rede de afiliados recusou o link (ID/parceria inválidos)' };
    if (DEAD_RE.test(text)) return { ok: false, kind: 'dead', reason: 'a loja informa que o produto não existe' };
    return { ok: true };
  } catch { return { ok: true, inconclusive: true }; }
  finally { clearTimeout(timer); }
}

function shopeeIds(url) {
  const u = String(url || '');
  let m = u.match(/\/product\/(\d+)\/(\d+)/) || u.match(/-i\.(\d+)\.(\d+)/);
  return m ? { shopId: m[1], itemId: m[2] } : null;
}

let shopeeCreds;
async function getShopeeCreds() {
  if (shopeeCreds !== undefined) return shopeeCreds;
  const { data: mp } = await supabaseAdmin.from('marketplaces').select('id').eq('slug', 'shopee').maybeSingle();
  if (!mp) return (shopeeCreds = null);
  const { data: c } = await supabaseAdmin.from('marketplace_credentials').select('client_id, client_secret').eq('marketplace_id', mp.id).maybeSingle();
  return (shopeeCreds = c && c.client_id && c.client_secret ? c : null);
}

// Confirma na API oficial da Shopee que o anúncio ainda existe e qual o preço de hoje.
async function checkShopee(p) {
  const ids = shopeeIds(p.original_url);
  const creds = await getShopeeCreds();
  if (!ids || !creds) return { ok: true, inconclusive: true };
  try {
    const node = await getProductOffer(creds.client_id, creds.client_secret, ids.itemId);
    if (!node) return { ok: false, kind: 'dead', reason: 'a Shopee não devolve mais esse anúncio (produto removido)' };
    const live = Number(String(node.priceMin).replace(',', '.'));
    return { ok: true, livePrice: Number.isFinite(live) && live > 0 ? live : null };
  } catch { return { ok: true, inconclusive: true }; }
}

// Retorna { ok, kind, reason, livePrice }
async function validatePromotion(p) {
  const slug = p.marketplaces && p.marketplaces.slug;
  if (slug === 'shopee') {
    const sh = await checkShopee(p);
    if (!sh.ok) return sh;
    if (sh.livePrice && Number(p.current_price) > 0 && sh.livePrice > Number(p.current_price) * 1.05) {
      return { ok: false, kind: 'stale', reason: `o preço subiu (de R$ ${money(p.current_price)} para R$ ${money(sh.livePrice)})` };
    }
  }
  return checkLink(p.affiliate_url);
}

async function ignorePromotion(p, why) {
  await supabaseAdmin.from('promotions').update({ status: 'IGNORED' }).eq('id', p.id);
  await supabaseAdmin.from('integration_logs').insert({ marketplace_id: null, level: 'warn', message: `Disparador removeu da fila "${String(p.title).slice(0, 60)}": ${why}` }).then(() => {}, () => {});
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


// Confere os próximos da fila SEM enviar nada. Quem não existe mais é removido (vai para "Ignoradas").
async function verifyQueue(res, body) {
  const dest = await getDestination(body.destination_id);
  if (!dest) return fail(res, 404, 'Destino não encontrado.');
  const list = await loadQueue(dest.id, body);
  const sample = list.slice(0, 12);
  const out = { total: list.length, checked: 0, ok: 0, removed: [], warnings: [] };
  for (const p of sample) {
    const check = await validatePromotion(p);
    out.checked += 1;
    if (check.ok) { out.ok += 1; continue; }
    if (check.kind === 'badlink') { out.warnings.push(check.reason); break; }
    if (check.kind === 'dead') await ignorePromotion(p, check.reason);
    out.removed.push({ title: p.title, reason: check.reason });
  }
  res.status(200).json(out);
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
  const skippedInfo = [];
  for (const p of list) {
    if (tries >= 8) break;
    tries += 1;
    // 1) o produto/link ainda existe e funciona?
    const check = await validatePromotion(p);
    if (!check.ok) {
      if (check.kind === 'badlink') {
        return fail(res, 409, `Parei por segurança: ${check.reason}. Confira o ID de afiliado em Marketplaces antes de continuar.`, { code: 'bad_link' });
      }
      if (check.kind === 'dead') await ignorePromotion(p, check.reason);
      await supabaseAdmin.from('dispatch_log').insert({ destination_id: dest.id, promotion_id: p.id, skipped: true, message: `pulada: ${check.reason}` });
      skippedInfo.push({ title: p.title, reason: check.reason });
      continue;
    }
    // 2) preço/cupom de agora
    const v = await buildView(p);
    if (v) { chosen = p; view = v; break; }
    await supabaseAdmin.from('dispatch_log').insert({ destination_id: dest.id, promotion_id: p.id, skipped: true, message: 'pulada: cupom não confirmado' });
    skippedInfo.push({ title: p.title, reason: 'o cupom dessa oferta não está mais válido' });
  }
  if (!chosen) return res.status(200).json({ empty: true, skipped: skippedInfo });

  chosen.view = view;
  const { count: total } = await supabaseAdmin.from('dispatch_log').select('id', { count: 'exact', head: true }).eq('destination_id', dest.id);
  const html = buildMessage(chosen, total || 0, String(body.footer || '').slice(0, 120));
  const remaining = Math.max(list.length - tries, 0);
  const slugName = chosen.marketplaces ? chosen.marketplaces.name : null;

  if (dest.platform === 'whatsapp_manual') {
    const plain = toPlain(html);
    await supabaseAdmin.from('dispatch_log').insert({ destination_id: dest.id, promotion_id: chosen.id, skipped: false, message: plain });
    return res.status(200).json({ ok: true, manual: true, message: plain, promotion: { title: chosen.title, coupon: view.coupon }, remaining, skipped: skippedInfo });
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
  res.status(200).json({ ok: true, sent: { title: chosen.title, marketplace: slugName, coupon: view.coupon }, remaining, skipped: skippedInfo });
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
      case 'verify': return await verifyQueue(res, body);
      case 'send_next': return await sendNext(res, body);
      default: return fail(res, 400, 'Ação inválida.');
    }
  } catch (err) {
    console.error('dispatch error', err);
    fail(res, 500, err.message || 'Erro inesperado no disparador.');
  }
};
