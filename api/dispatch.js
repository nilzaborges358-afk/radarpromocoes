const { supabaseAdmin } = require('../src/core/database/supabaseClient');
const { getNetshoesContext, loadNetshoesCoupons, bestNetshoesCoupon } = require('../src/core/coupons');
const { getProductOffer } = require('../src/integrations/shopee/client');

// Disparador de promo--es (Telegram autom-tico / WhatsApp assistido).
// GET  /api/dispatch                      -> lista destinos
// POST /api/dispatch { action: ... }      -> create_destination | delete_destination | test | queue | verify | send_next | job_start | job_stop | job_ack | tick
// Precisa das tabelas dispatch_destinations e dispatch_log (SQL em supabase/migrations/0002_disparador.sql).

const QUEUE_DAYS_SEEN = 3;     // s\u00f3 promo\u00e7\u00f5es vistas pela busca nos \u00faltimos 3 dias
const NO_REPEAT_DAYS = 14;     // n\u00e3o repete a mesma promo\u00e7\u00e3o no mesmo destino por 2 semanas
const MIN_GAP_SECONDS = 20;    // trava anti-duplo-clique
const COUPON_CACHE_MS = 10 * 60 * 1000;
let couponCache = { at: 0, list: null };

// ---------------- utilit-rios ----------------

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
    return 'As tabelas do disparador ainda nao existem no Supabase. Rode os SQLs 0002_disparador.sql e 0003_disparo_continuo.sql (SQL Editor > New query) e tente de novo.';
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
  if (/unauthorized|not found/i.test(m) && err.status === 401) return 'Token do bot inv\u00e1lido. Copie de novo no @BotFather.';
  if (/chat not found/i.test(m)) return 'Chat n\u00e3o encontrado. Confira o @canal (ou id) e se o bot foi adicionado ao canal/grupo.';
  if (/not enough rights|have no rights|administrator|forbidden/i.test(m)) return 'O bot n\u00e3o tem permiss\u00e3o para postar. Em canal, torne o bot administrador com permiss\u00e3o de postar.';
  return m;
}

// ---------------- mensagens (v-rias varia--es) ----------------

const OPENERS = ['\ud83d\udd25', '\ud83d\uded2', '\ud83d\udc40', '\ud83d\udca5', '\u26a1', '\ud83d\ude0d'];

function pick(arr, n) { return arr[Math.abs(n) % arr.length]; }

// Monta o texto. "turn" gira entre os modelos, ent-o duas mensagens seguidas nunca saem iguais.
// Tom: quem est- compartilhando achou uma oferta boa. Nada de aviso t-cnico/-link de afiliado- no texto.
function buildMessage(p, turn, footer) {
  const emoji = pick(OPENERS, turn + p.title.length);
  const title = esc(p.title);
  const link = esc(p.affiliate_url);
  const { price, listPrice, coupon, finalPrice } = p.view;
  const off = p.view.discount ? Math.round(p.view.discount) : null;
  const hasList = listPrice && listPrice > price;
  const now = coupon ? finalPrice : price;

  const priceLine = hasList
    ? `\ud83d\udcb0 De <s>R$ ${money(listPrice)}</s> por <b>R$ ${money(now)}</b>${off ? ` (${off}% OFF)` : ''}`
    : `\ud83d\udcb0 Por apenas <b>R$ ${money(now)}</b>${off ? ` (${off}% OFF)` : ''}`;
  const couponLine = coupon ? `\ud83c\udf9f\ufe0f Use o cupom <b>${esc(coupon)}</b> no carrinho` : null;
  const storeLine = coupon ? `\ud83d\udcb3 Pre\u00e7o na loja: R$ ${money(price)}` : null;

  const templates = [
    () => [`${emoji} <b>Olha o que a gente encontrou!</b>`, '', title, '', priceLine, couponLine, '', `\ud83d\uded2 Aproveite: ${link}`],
    () => [`${emoji} <b>Oferta boa demais pra deixar passar</b>`, '', title, '', priceLine, couponLine, '', `\ud83d\udc49 ${link}`],
    () => [`\u2705 <b>Separamos essa pra voc\u00ea</b>`, '', title, priceLine, storeLine, couponLine, '', `Garanta aqui \ud83d\udc47`, link],
    () => [`${emoji} <b>Achado do dia</b>`, title, '', priceLine, couponLine, '', `\ud83d\uded2 ${link}`],
    () => [`${emoji} <b>Pre\u00e7o bom apareceu!</b>`, '', title, '', priceLine, couponLine, '', `Corre ver: ${link}`],
    () => [`\u2b50 <b>Recomenda\u00e7\u00e3o do dia</b>`, '', title, '', priceLine, couponLine, '', `\ud83d\udc49 Confira aqui: ${link}`],
  ];

  const lines = templates[Math.abs(turn) % templates.length]().filter((l) => l !== null && l !== undefined);
  const cleaned = [];
  for (const l of lines) { if (l === '' && (cleaned.length === 0 || cleaned[cleaned.length - 1] === '')) continue; cleaned.push(l); }
  // Rodap- opcional - mas nunca deixa sair aviso de "afiliado".
  const safeFooter = footer && !/afiliad/i.test(footer) ? footer : '';
  if (safeFooter) cleaned.push('', esc(safeFooter));
  return cleaned.join('\n');
}

// Vers-o sem HTML para o WhatsApp (que n-o entende <b>/<s>).
function toPlain(html) {
  return html.replace(/<\/?(b|s)>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}


// ---------------- valida--o antes de enviar ----------------

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DEAD_RE = /o produto n[\u00e3a]o existe|produto n[\u00e3a]o encontrado|p[\u00e1a]gina n[\u00e3a]o encontrada|produto indispon[\u00edi]vel|product (does not exist|not found)/i;
const BADLINK_RE = /invalid publisher code|partnership status/i;

// Abre o link como um cliente abriria e procura sinais claros de problema.
// S- reprova quando o sinal - claro; se o site bloquear/der erro de rede, segue (inconclusivo).
async function checkLink(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9', Accept: 'text/html,*/*' } });
    if (r.status === 404 || r.status === 410) return { ok: false, kind: 'dead', reason: `a p\u00e1gina do produto n\u00e3o existe mais (erro ${r.status})` };
    const text = (await r.text().catch(() => '')).slice(0, 40000);
    if (BADLINK_RE.test(text)) return { ok: false, kind: 'badlink', reason: 'a rede de afiliados recusou o link (ID/parceria inv\u00e1lidos)' };
    if (DEAD_RE.test(text)) return { ok: false, kind: 'dead', reason: 'a loja informa que o produto n\u00e3o existe' };
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

// Confirma na API oficial da Shopee que o an-ncio ainda existe e qual o pre-o de hoje.
async function checkShopee(p) {
  const ids = shopeeIds(p.original_url);
  const creds = await getShopeeCreds();
  if (!ids || !creds) return { ok: true, inconclusive: true };
  try {
    const node = await getProductOffer(creds.client_id, creds.client_secret, ids.itemId);
    if (!node) return { ok: false, kind: 'dead', reason: 'a Shopee n\u00e3o devolve mais esse an\u00fancio (produto removido)' };
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
      return { ok: false, kind: 'stale', reason: `o pre\u00e7o subiu (de R$ ${money(p.current_price)} para R$ ${money(sh.livePrice)})` };
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

// Calcula o que vai aparecer na mensagem. Retorna null se a promo--o n-o vale mais (ex.: cupom venceu).
async function buildView(p) {
  const slug = p.marketplaces && p.marketplaces.slug;
  let price = Number(p.current_price);
  let listPrice = p.previous_price ? Number(p.previous_price) : null;
  let coupon = null; let finalPrice = null;

  if (slug === 'netshoes') {
    const fromCoupon = p.source === 'netshoes_coupon';
    // Em ofertas por cupom, current_price j- - o pre-o COM cupom e previous_price - o pre-o da loja.
    const storePrice = fromCoupon ? Number(p.previous_price) : price;
    const list = await netshoesCoupons();
    const best = list && storePrice > 0 ? bestNetshoesCoupon(list, { title: p.title, price: storePrice, category: null }) : null;
    if (best) {
      coupon = best.coupon.code; finalPrice = r2(best.finalPrice); price = r2(storePrice);
      listPrice = fromCoupon ? null : listPrice;
    } else if (fromCoupon) {
      return null; // a oferta dependia de um cupom que n\u00e3o consigo confirmar agora
    }
  }

  const base = coupon ? finalPrice : price;
  const ref = listPrice && listPrice > price ? listPrice : (coupon ? price : null);
  const discount = ref && base < ref ? ((ref - base) / ref) * 100 : (p.discount_rate ? Number(p.discount_rate) : null);
  return { price: r2(price), listPrice: listPrice ? r2(listPrice) : null, coupon, finalPrice, discount };
}

// ---------------- a--es ----------------

async function createDestination(res, body) {
  const platform = body.platform === 'whatsapp_manual' ? 'whatsapp_manual' : 'telegram';
  const name = String(body.name || '').replace(/\s+/g, ' ').trim();
  if (!name) return fail(res, 400, 'D\u00ea um nome ao destino (ex.: Achadinhos).');
  const dailyLimit = Math.min(Math.max(parseInt(body.daily_limit, 10) || 60, 1), 200);

  const row = { name: name.slice(0, 80), platform, daily_limit: dailyLimit, chat_id: null, bot_token: null };
  let botUsername = null;

  if (platform === 'telegram') {
    const chat = String(body.chat_id || '').trim();
    const token = String(body.bot_token || '').trim();
    if (!chat) return fail(res, 400, 'Preencha o Chat (@nome_do_canal ou o id num\u00e9rico).');
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
  const [counts, payload] = await Promise.all([
    Promise.all((data || []).map((d) => supabaseAdmin.from('dispatch_log').select('id', { count: 'exact', head: true })
      .eq('destination_id', d.id).eq('skipped', false).gte('sent_at', since).then((r) => r.count || 0, () => 0))),
    jobsPayload(),
  ]);
  const out = (data || []).map((d, i) => ({ ...d, sentLast24h: counts[i] }));
  res.status(200).json({ destinations: out, jobs: payload.jobs, now: payload.now });
}

async function sendTest(res, body) {
  const dest = await getDestination(body.destination_id);
  if (!dest) return fail(res, 404, 'Destino n\u00e3o encontrado.');
  const text = '\u2705 Teste do Radar de Promo\u00e7\u00f5es: se voc\u00ea est\u00e1 lendo isso, o destino est\u00e1 funcionando.';
  if (dest.platform === 'whatsapp_manual') return res.status(200).json({ ok: true, manual: true, message: text });
  try { await telegram(dest.bot_token, 'sendMessage', { chat_id: dest.chat_id, text }); }
  catch (err) { return fail(res, 400, friendlyTelegramError(err)); }
  res.status(200).json({ ok: true });
}

async function queue(res, body) {
  const dest = await getDestination(body.destination_id);
  if (!dest) return fail(res, 404, 'Destino n\u00e3o encontrado.');
  const list = await loadQueue(dest.id, body);
  if (!list.length) return res.status(200).json({ count: 0 });
  const n = list[0];
  res.status(200).json({
    count: list.length,
    next: { title: n.title, price: Number(n.current_price), discount: n.discount_rate ? Number(n.discount_rate) : null, marketplace: n.marketplaces ? n.marketplaces.name : null },
  });
}


// Confere os pr-ximos da fila SEM enviar nada. Quem n-o existe mais - removido (vai para "Ignoradas").
async function verifyQueue(res, body) {
  const dest = await getDestination(body.destination_id);
  if (!dest) return fail(res, 404, 'Destino n\u00e3o encontrado.');
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
  if (!dest) return fail(res, 404, 'Destino n\u00e3o encontrado.');

  // limite di-rio e trava anti-duplo-clique
  const { count: sent24 } = await supabaseAdmin.from('dispatch_log').select('id', { count: 'exact', head: true })
    .eq('destination_id', dest.id).eq('skipped', false).gte('sent_at', isoAgo(DAY));
  if ((sent24 || 0) >= dest.daily_limit) return fail(res, 429, `Limite de ${dest.daily_limit} envios em 24h atingido para "${dest.name}".`, { code: 'daily_limit' });

  const { data: last } = await supabaseAdmin.from('dispatch_log').select('sent_at').eq('destination_id', dest.id).eq('skipped', false)
    .order('sent_at', { ascending: false }).limit(1);
  if (last && last[0] && Date.now() - new Date(last[0].sent_at).getTime() < MIN_GAP_SECONDS * 1000) {
    return fail(res, 429, 'Envio muito r\u00e1pido, aguardando alguns segundos.', { code: 'too_fast' });
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
        return fail(res, 409, `Parei por seguran\u00e7a: ${check.reason}. Confira o ID de afiliado em Marketplaces antes de continuar.`, { code: 'bad_link' });
      }
      if (check.kind === 'dead') await ignorePromotion(p, check.reason);
      await supabaseAdmin.from('dispatch_log').insert({ destination_id: dest.id, promotion_id: p.id, skipped: true, message: `pulada: ${check.reason}` });
      skippedInfo.push({ title: p.title, reason: check.reason });
      continue;
    }
    // 2) pre-o/cupom de agora
    const v = await buildView(p);
    if (v) { chosen = p; view = v; break; }
    await supabaseAdmin.from('dispatch_log').insert({ destination_id: dest.id, promotion_id: p.id, skipped: true, message: 'pulada: cupom n\u00e3o confirmado' });
    skippedInfo.push({ title: p.title, reason: 'o cupom dessa oferta n\u00e3o est\u00e1 mais v\u00e1lido' });
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
      } catch (e) { if (e.status === 429) throw e; /* imagem recusada: manda s\u00f3 o texto */ }
    }
    if (!done) await telegram(dest.bot_token, 'sendMessage', { chat_id: dest.chat_id, text: html, parse_mode: 'HTML', disable_web_page_preview: false });
  } catch (err) {
    if (err.status === 429) return fail(res, 429, 'Telegram pediu para ir mais devagar.', { code: 'rate_limited', retryAfter: err.retryAfter || 60 });
    return fail(res, 502, friendlyTelegramError(err));
  }

  await supabaseAdmin.from('dispatch_log').insert({ destination_id: dest.id, promotion_id: chosen.id, skipped: false, message: toPlain(html) });
  res.status(200).json({ ok: true, sent: { title: chosen.title, marketplace: slugName, coupon: view.coupon }, remaining, skipped: skippedInfo });
}


// ---------------- disparo continuo (estado no servidor) ----------------

const CLAIM_STALE_MS = 150 * 1000;

function fakeRes() {
  return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

async function jobsPayload() {
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from('dispatch_jobs').select('*');
  if (error) return { jobs: [], now, jobsError: error.message };
  return { jobs: data || [], now };
}

async function startJob(res, body) {
  const dest = await getDestination(body.destination_id);
  if (!dest) return fail(res, 404, 'Destino nao encontrado.');
  const isTelegram = dest.platform === 'telegram';
  const interval = Math.max(parseInt(body.interval_min, 10) || 0, isTelegram ? 2 : 1);
  const maxSends = Math.min(Math.max(parseInt(body.max_sends, 10) || 20, 1), 500);
  const footer = String(body.footer || '').slice(0, 120);
  const nowIso = new Date().toISOString();
  const row = {
    destination_id: dest.id, mode: isTelegram ? 'auto' : 'assisted', status: 'running',
    interval_min: interval, max_sends: maxSends, sent_count: 0, next_run_at: nowIso, claimed_at: null,
    filters: { group_ids: Array.isArray(body.group_ids) ? body.group_ids : [], marketplace: body.marketplace || null, footer },
    pending: null, last_event: 'Disparo iniciado.', last_error: null, error_streak: 0, updated_at: nowIso,
  };
  const { error } = await supabaseAdmin.from('dispatch_jobs').upsert(row, { onConflict: 'destination_id' });
  if (error) return fail(res, 500, dbError(error));
  res.status(200).json(await jobsPayload());
}

async function stopJob(res, body) {
  const { error } = await supabaseAdmin.from('dispatch_jobs')
    .update({ status: 'stopped', pending: null, claimed_at: null, last_event: 'Parado por voce.', updated_at: new Date().toISOString() })
    .eq('destination_id', body.destination_id);
  if (error) return fail(res, 500, dbError(error));
  res.status(200).json(await jobsPayload());
}

// WhatsApp assistido: a pessoa abriu o WhatsApp -> conta como enviado e recomeca a contagem.
async function ackJob(res, body) {
  const { data: job, error } = await supabaseAdmin.from('dispatch_jobs').select('*').eq('destination_id', body.destination_id).maybeSingle();
  if (error) return fail(res, 500, dbError(error));
  if (job && job.pending) {
    const sent = job.sent_count + 1;
    const done = sent >= job.max_sends;
    await supabaseAdmin.from('dispatch_jobs').update({
      pending: null, sent_count: sent, status: done ? 'stopped' : 'running',
      next_run_at: new Date(Date.now() + job.interval_min * 60000).toISOString(),
      last_event: done ? `Meta de ${job.max_sends} envios atingida.` : `Aberto no WhatsApp: ${String(job.pending.title || '').slice(0, 60)}`,
      last_error: null, updated_at: new Date().toISOString(),
    }).eq('id', job.id);
  }
  res.status(200).json(await jobsPayload());
}

async function processJob(job) {
  const nowIso = () => new Date().toISOString();
  const finish = (patch) => supabaseAdmin.from('dispatch_jobs').update({ claimed_at: null, updated_at: nowIso(), ...patch }).eq('id', job.id);
  let r;
  try {
    const dest = await getDestination(job.destination_id);
    if (!dest) { await finish({ status: 'stopped', last_error: 'Destino removido.' }); return; }
    const f = job.filters || {};
    const fr = fakeRes();
    await sendNext(fr, { destination_id: dest.id, group_ids: f.group_ids || [], marketplace: f.marketplace || null, footer: f.footer || '' });
    r = { status: fr.code, json: fr.body || {} };
  } catch (e) {
    r = { status: 500, json: { error: e.message || 'erro inesperado' } };
  }

  const j = r.json;
  const skippedTxt = j.skipped && j.skipped.length ? ` (${j.skipped.length} pulada(s) por problema no produto)` : '';

  if (r.status === 200 && j.empty) {
    await finish({ status: 'stopped', pending: null, last_event: 'A fila acabou: nao ha mais promocoes validas para esse filtro.' + skippedTxt });
    return;
  }
  if (r.status === 200) {
    if (job.mode === 'assisted') {
      await finish({
        pending: { message: j.message, title: j.promotion.title, coupon: j.promotion.coupon, remaining: j.remaining, prepared_at: nowIso() },
        last_event: 'Promocao pronta para enviar.' + skippedTxt, last_error: null, error_streak: 0,
      });
      return;
    }
    const sent = job.sent_count + 1;
    const done = sent >= job.max_sends;
    const t = (j.sent && j.sent.title ? j.sent.title : '').slice(0, 70);
    await finish({
      sent_count: sent, status: done ? 'stopped' : 'running',
      next_run_at: new Date(Date.now() + job.interval_min * 60000).toISOString(),
      last_event: (done ? `Meta de ${job.max_sends} envios atingida. ` : '') + `Enviado: ${t}${j.sent && j.sent.coupon ? ` (cupom ${j.sent.coupon})` : ''}${skippedTxt}`,
      last_error: null, error_streak: 0,
    });
    return;
  }
  // erros
  const code = j.code;
  const msg = j.error || 'Falha ao enviar.';
  if (code === 'daily_limit' || code === 'bad_link') { await finish({ status: 'stopped', pending: null, last_error: msg }); return; }
  if (code === 'rate_limited') { await finish({ next_run_at: new Date(Date.now() + ((j.retryAfter || 60) + 1) * 1000).toISOString(), last_error: msg }); return; }
  const streak = (job.error_streak || 0) + 1;
  if (streak >= 30) { await finish({ status: 'stopped', error_streak: streak, last_error: `${msg} (parei apos 30 falhas seguidas)` }); return; }
  await finish({ next_run_at: new Date(Date.now() + 60000).toISOString(), error_streak: streak, last_error: msg });
}

// Roda os disparos que ja estao na hora. Pode ser chamado pela pagina aberta ou por um "relogio" externo.
async function tickJobs() {
  const nowIso = new Date().toISOString();
  const { data: due, error } = await supabaseAdmin.from('dispatch_jobs').select('*')
    .eq('status', 'running').is('pending', null).lte('next_run_at', nowIso).limit(3);
  if (error) throw new Error(dbError(error));
  const work = [];
  for (const j of due || []) {
    const stale = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
    // "trava" atomica: so quem conseguir marcar o claimed_at executa (evita envio duplicado)
    const { data: claimed } = await supabaseAdmin.from('dispatch_jobs').update({ claimed_at: nowIso })
      .eq('id', j.id).eq('status', 'running').lte('next_run_at', nowIso)
      .or(`claimed_at.is.null,claimed_at.lt.${stale}`).select().maybeSingle();
    if (claimed) work.push(processJob(claimed));
  }
  await Promise.all(work);
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      if (req.query && req.query.tick) { await tickJobs(); return res.status(200).json({ ok: true }); }
      return await listDestinations(res);
    }
    if (req.method !== 'POST') return fail(res, 405, 'M\u00e9todo n\u00e3o permitido.');

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
      case 'job_start': return await startJob(res, body);
      case 'job_stop': return await stopJob(res, body);
      case 'job_ack': return await ackJob(res, body);
      case 'tick': await tickJobs(); return res.status(200).json(await jobsPayload());
      case 'send_next': return await sendNext(res, body);
      default: return fail(res, 400, 'A\u00e7\u00e3o inv\u00e1lida.');
    }
  } catch (err) {
    console.error('dispatch error', err);
    fail(res, 500, err.message || 'Erro inesperado no disparador.');
  }
};
