const VERSION = 'dispatch-v2026-10-17.1';

// Carregamento protegido: se alguma peca faltar no deploy, a API responde dizendo QUAL (em vez de cair com erro 500).
let supabaseAdmin = null;
let LOAD_ERROR = null;
try { supabaseAdmin = require('../src/core/database/supabaseClient').supabaseAdmin; }
catch (e) { LOAD_ERROR = `Nao consegui carregar o banco (src/core/database/supabaseClient.js): ${e.message}`; }
function coupons() { try { return require('../src/core/coupons'); } catch { return {}; } }
function shopeeClient() { try { return require('../src/integrations/shopee/client'); } catch { return {}; } }
function dedupeLib() { try { return require('../src/core/dedupe'); } catch { return null; } }

// Disparador de promo--es (Telegram autom-tico / WhatsApp assistido).
// GET  /api/dispatch                      -> lista destinos
// POST /api/dispatch { action: ... }      -> create_destination | delete_destination | test | queue | verify | send_next | job_start | job_stop | job_ack | tick | bot_poll | bot_ack
// Modo ROBO (WhatsApp 100% automatico): o servidor prepara a mensagem na hora certa e o robo que roda no
// notebook (robo-whatsapp) busca em bot_poll, envia no WhatsApp e confirma em bot_ack.
// Precisa das tabelas dispatch_destinations e dispatch_log (SQL em supabase/migrations/0002_disparador.sql).

const QUEUE_DAYS_SEEN = 1;     // so promocoes vistas pela busca nas ultimas 24h (precos de hoje)
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

// Paleta de emojis (escolhida pelo dono): - - - -- - - - - - - - -- -
const OPENERS = ['\ud83d\udd25', '\ud83d\udc40', '\ud83e\udd29', '\ud83d\udecd\ufe0f', '\ud83c\udfaf'];
const LINK_EMOJIS = ['\ud83d\udc49', '\ud83d\udcf2', '\ud83d\udd17'];

function pick(arr, n) { return arr[Math.abs(n) % arr.length]; }

// Emoji do assunto, pelo que o produto e (cozinha, casa, eletronicos).
function categoryEmoji(title) {
  const t = String(title || '').toLowerCase();
  if (/panela|frigideira|cozinha|air ?fryer|fritadeira|talher|prato|copo|garrafa|esponja|marmita|assadeira|faca|utens[i\u00ed]lio/.test(t)) return '\ud83c\udf73';
  if (/celular|smartphone|fone|carregador|cabo |usb|bluetooth|caixa de som|smartwatch|mouse|teclado|notebook|tablet|c[a\u00e2]mera|inteligente|led /.test(t)) return '\ud83d\udcf1';
  if (/toalha|lixeira|banheiro|cama|len[c\u00e7]ol|travesseiro|organizador|cesto|tapete|cortina|sof[a\u00e1]|limpeza|vassoura|rodo|aspirador|sensor/.test(t)) return '\ud83c\udfe0';
  return null;
}

// Monta o texto. "turn" gira entre os modelos, entao duas mensagens seguidas nunca saem iguais.
// Tom: quem esta compartilhando achou uma oferta boa. Nada de aviso tecnico/"link de afiliado" no texto.
function buildMessage(p, turn, footer) {
  const head = categoryEmoji(p.title) || pick(OPENERS, turn + p.title.length);
  const go = pick(LINK_EMOJIS, turn);
  const title = esc(p.title);
  const link = esc(p.affiliate_url);
  const { price, listPrice, coupon, finalPrice } = p.view;
  const off = p.view.discount ? Math.round(p.view.discount) : null;
  const hasList = listPrice && listPrice > price;
  const now = coupon ? finalPrice : price;

  const priceLine = hasList
    ? `\ud83d\udcb8 De <s>R$ ${money(listPrice)}</s> por <b>R$ ${money(now)}</b>${off ? ` (${off}% OFF)` : ''}`
    : `\ud83d\udcb8 Por apenas <b>R$ ${money(now)}</b>${off ? ` (${off}% OFF)` : ''}`;
  const couponLine = coupon ? `\ud83d\udecd\ufe0f Use o cupom <b>${esc(coupon)}</b> no carrinho` : null;
  const storeLine = coupon ? `Pre\u00e7o na loja: R$ ${money(price)}` : null;
  const warn = '\u26a0\ufe0f Pre\u00e7o e estoque podem mudar a qualquer momento';

  const templates = [
    () => [`${head} <b>Olha o que a gente encontrou!</b>`, '', title, '', priceLine, couponLine, '', `${go} Aproveite: ${link}`],
    () => [`${head} <b>Oferta boa demais pra deixar passar</b>`, '', title, '', priceLine, couponLine, '', warn, '', `${go} ${link}`],
    () => [`\ud83e\udd29 <b>Separamos essa pra voc\u00ea</b>`, '', `${head === '\ud83e\udd29' ? '' : head + ' '}${title}`, priceLine, storeLine, couponLine, '', `Garanta aqui ${go}`, link],
    () => [`${head} <b>Achado do dia</b>`, title, '', priceLine, couponLine, '', `${go} ${link}`],
    () => [`\ud83d\udd25 <b>Pre\u00e7o bom apareceu!</b>`, '', `${head === '\ud83d\udd25' ? '' : head + ' '}${title}`, '', priceLine, couponLine, '', warn, '', `${go} Corre ver: ${link}`],
    () => [`\ud83c\udfaf <b>Recomenda\u00e7\u00e3o do dia</b>`, '', `${head === '\ud83c\udfaf' ? '' : head + ' '}${title}`, '', priceLine, couponLine, '', `${go} Confira aqui: ${link}`],
  ];

  const lines = templates[Math.abs(turn) % templates.length]().filter((l) => l !== null && l !== undefined);
  const cleaned = [];
  for (const l of lines) { if (l === '' && (cleaned.length === 0 || cleaned[cleaned.length - 1] === '')) continue; cleaned.push(l); }
  // Linha final opcional - mas nunca deixa sair aviso de "afiliado".
  const safeFooter = footer && !/afiliad/i.test(footer) ? footer : '';
  if (safeFooter) cleaned.push('', esc(safeFooter));
  return cleaned.join('\n');
}

// Vers-o sem HTML para o WhatsApp (que n-o entende <b>/<s>).
function toPlain(html) {
  return html.replace(/<\/?(b|s)>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// Versao para WhatsApp: negrito vira *texto* e riscado vira ~texto~ (o WhatsApp entende os dois).
function toWhatsApp(html) {
  return html.replace(/<\/?b>/g, '*').replace(/<\/?s>/g, '~').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
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
    const sc = shopeeClient();
    if (!sc.getProductOffer) return { ok: true, inconclusive: true };
    const node = await sc.getProductOffer(creds.client_id, creds.client_secret, ids.itemId);
    if (!node) return { ok: false, kind: 'dead', reason: 'a Shopee n\u00e3o devolve mais esse an\u00fancio (produto removido)' };
    const live = Number(String(node.priceMin).replace(',', '.'));
    return { ok: true, livePrice: Number.isFinite(live) && live > 0 ? live : null };
  } catch { return { ok: true, inconclusive: true }; }
}

// Retorna { ok, kind, reason, livePrice }
async function validatePromotion(p) {
  const slug = p.marketplaces && p.marketplaces.slug;
  let live = null;
  if (slug === 'shopee') {
    const sh = await checkShopee(p);
    if (!sh.ok) return sh;
    live = sh.livePrice || null;
    if (live && Number(p.current_price) > 0 && live > Number(p.current_price) * 1.05) {
      return { ok: false, kind: 'stale', reason: `o pre\u00e7o subiu (de R$ ${money(p.current_price)} para R$ ${money(live)})` };
    }
  }
  const lk = await checkLink(p.affiliate_url);
  return lk.ok ? { ...lk, livePrice: live } : lk;
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
    .from('dispatch_log').select('promotion_id, skipped').eq('destination_id', destId).gte('sent_at', isoAgo(NO_REPEAT_DAYS * DAY));
  if (logErr) throw new Error(dbError(logErr));
  const already = new Set((logs || []).map((l) => l.promotion_id));

  const wantNone = groupIds.includes('none');
  const mp = body.marketplace || null;

  let list = (data || []).filter((p) => {
    if (already.has(p.id)) return false;
    if (!/^https?:\/\//i.test(p.affiliate_url || '')) return false;
    if (mp && (!p.marketplaces || p.marketplaces.slug !== mp)) return false;
    if (groupIds.length) {
      if (p.watch_group_id) { if (!groupIds.includes(p.watch_group_id)) return false; }
      else if (!wantNone) return false;
    }
    return true;
  });

  // Promocoes com queda de preco COMPROVADA saem antes das que so tem "desconto de tabela" informado
  // pela Shopee (preco de tabela inflado e comum). Dentro de cada faixa, maior desconto primeiro.
  const rank = (p) => (p.source === 'shopee_listed_price' ? 1 : 0);
  list = list.map((p, i) => ({ p, i })).sort((a, b) => (rank(a.p) - rank(b.p)) || (a.i - b.i)).map((x) => x.p);

  // Mesmo PRODUTO (outro vendedor, outro link) nao pode sair duas vezes:
  //  1) nao repete produto parecido com algo ja ENVIADO a este destino nas ultimas 2 semanas;
  //  2) entre parecidos na propria fila, fica so o mais barato.
  const dd = dedupeLib();
  if (dd && list.length) {
    const sentIds = (logs || []).filter((l) => !l.skipped).map((l) => l.promotion_id).filter(Boolean);
    if (sentIds.length) {
      const sentIndex = new dd.SimilarIndex();
      for (let i = 0; i < sentIds.length; i += 100) {
        const { data: sentRows } = await supabaseAdmin.from('promotions').select('id, title').in('id', sentIds.slice(i, i + 100));
        (sentRows || []).forEach((r) => sentIndex.add(r.title, r));
      }
      if (sentIndex.size) list = list.filter((p) => !sentIndex.findSimilar(p.title));
    }
    list = dd.keepCheapestOfEach(list, (p) => p.title, (p) => Number(p.current_price));
  }
  return list;
}

async function netshoesCoupons() {
  if (couponCache.list && Date.now() - couponCache.at < COUPON_CACHE_MS) return couponCache.list;
  try {
    const cp = coupons();
    if (!cp.getNetshoesContext || !cp.loadNetshoesCoupons) return null;
    const ctx = await cp.getNetshoesContext(supabaseAdmin);
    if (ctx.error) return null;
    const loaded = await cp.loadNetshoesCoupons(ctx);
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
    const best = list && storePrice > 0 && coupons().bestNetshoesCoupon ? coupons().bestNetshoesCoupon(list, { title: p.title, price: storePrice, category: null }) : null;
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

  // No WhatsApp, chat_id guarda o NOME do grupo (usado pelo robo). No Telegram, o @canal/id.
  const row = { name: name.slice(0, 80), platform, daily_limit: dailyLimit, chat_id: platform === 'whatsapp_manual' ? (String(body.chat_id || '').replace(/\s+/g, ' ').trim().slice(0, 120) || null) : null, bot_token: null };
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
  // bot_seen_at e criado pelo SQL 0004; se ele ainda nao foi rodado, cai para a consulta antiga.
  let q = await supabaseAdmin.from('dispatch_destinations').select('id, name, platform, chat_id, daily_limit, created_at, bot_seen_at').order('created_at');
  if (q.error && /bot_seen_at/i.test(String(q.error.message || ''))) {
    q = await supabaseAdmin.from('dispatch_destinations').select('id, name, platform, chat_id, daily_limit, created_at').order('created_at');
  }
  const { data, error } = q;
  if (error) return fail(res, 500, dbError(error));
  const since = isoAgo(DAY);
  const [counts, payload] = await Promise.all([
    Promise.all((data || []).map((d) => supabaseAdmin.from('dispatch_log').select('id', { count: 'exact', head: true })
      .eq('destination_id', d.id).eq('skipped', false).gte('sent_at', since).then((r) => r.count || 0, () => 0))),
    jobsPayload(),
  ]);
  const out = (data || []).map((d, i) => ({ ...d, sentLast24h: counts[i] }));
  res.status(200).json({ destinations: out, jobs: payload.jobs, now: payload.now, botSeenAt: payload.botSeenAt || null, version: VERSION });
}

async function sendTest(res, body) {
  const dest = await getDestination(body.destination_id);
  if (!dest) return fail(res, 404, 'Destino n\u00e3o encontrado.');
  const text = '\u2705 Teste do Radar de Promo\u00e7\u00f5es: se voc\u00ea est\u00e1 lendo isso, o destino est\u00e1 funcionando.\n\n\ud83d\udc40 \ud83d\udd25 \ud83e\udd29 \ud83d\udecd\ufe0f \ud83d\udcb8 \ud83c\udfe0 \ud83d\udcf1 \ud83c\udf73 \ud83c\udfaf \ud83d\udcf2 \ud83d\udc49 \u26a0\ufe0f \ud83d\udd17';
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
    newestSeenAt: list.reduce((m, p) => { const t = p.last_seen_at || p.detected_at; return t && (!m || t > m) ? t : m; }, null),
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

// Escolhe e confere a proxima promocao (sem enviar nada). Devolve:
//  { error: { status, message, extra } } | { empty: true, skipped } | { chosen, view, html, remaining, skippedInfo }
async function prepareNext(dest, body) {
  // limite diario e trava anti-duplo-clique
  const { count: sent24 } = await supabaseAdmin.from('dispatch_log').select('id', { count: 'exact', head: true })
    .eq('destination_id', dest.id).eq('skipped', false).gte('sent_at', isoAgo(DAY));
  if ((sent24 || 0) >= dest.daily_limit) return { error: { status: 429, message: `Limite de ${dest.daily_limit} envios em 24h atingido para "${dest.name}".`, extra: { code: 'daily_limit' } } };

  const { data: last } = await supabaseAdmin.from('dispatch_log').select('sent_at').eq('destination_id', dest.id).eq('skipped', false)
    .order('sent_at', { ascending: false }).limit(1);
  if (last && last[0] && Date.now() - new Date(last[0].sent_at).getTime() < MIN_GAP_SECONDS * 1000) {
    return { error: { status: 429, message: 'Envio muito r\u00e1pido, aguardando alguns segundos.', extra: { code: 'too_fast' } } };
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
        return { error: { status: 409, message: `Parei por seguran\u00e7a: ${check.reason}. Confira o ID de afiliado em Marketplaces antes de continuar.`, extra: { code: 'bad_link' } } };
      }
      if (check.kind === 'dead') await ignorePromotion(p, check.reason);
      await supabaseAdmin.from('dispatch_log').insert({ destination_id: dest.id, promotion_id: p.id, skipped: true, message: `pulada: ${check.reason}` });
      skippedInfo.push({ title: p.title, reason: check.reason });
      continue;
    }
    // 1b) preco de AGORA (Shopee confirma na API): usa o preco real e descarta se deixou de ser desconto
    if (check.livePrice && Math.abs(check.livePrice - Number(p.current_price)) >= 0.01) {
      const prev = p.previous_price ? Number(p.previous_price) : null;
      if (prev && check.livePrice >= prev) {
        await supabaseAdmin.from('dispatch_log').insert({ destination_id: dest.id, promotion_id: p.id, skipped: true, message: 'pulada: sem desconto agora' });
        skippedInfo.push({ title: p.title, reason: 'o pre\u00e7o atual n\u00e3o est\u00e1 mais em promo\u00e7\u00e3o' });
        continue;
      }
      p.current_price = check.livePrice;
      p.discount_rate = prev ? Math.round(((prev - check.livePrice) / prev) * 10000) / 100 : p.discount_rate;
      supabaseAdmin.from('promotions').update({ current_price: p.current_price, discount_rate: p.discount_rate, last_seen_at: new Date().toISOString() }).eq('id', p.id).then(() => {}, () => {});
    }
    // 2) preco/cupom de agora
    const v = await buildView(p);
    if (v) { chosen = p; view = v; break; }
    await supabaseAdmin.from('dispatch_log').insert({ destination_id: dest.id, promotion_id: p.id, skipped: true, message: 'pulada: cupom n\u00e3o confirmado' });
    skippedInfo.push({ title: p.title, reason: 'o cupom dessa oferta n\u00e3o est\u00e1 mais v\u00e1lido' });
  }
  if (!chosen) return { empty: true, skipped: skippedInfo };

  chosen.view = view;
  const { count: total } = await supabaseAdmin.from('dispatch_log').select('id', { count: 'exact', head: true }).eq('destination_id', dest.id);
  const html = buildMessage(chosen, total || 0, String(body.footer || '').slice(0, 120));
  return { chosen, view, html, remaining: Math.max(list.length - tries, 0), skippedInfo };
}

async function sendNext(res, body) {
  const dest = await getDestination(body.destination_id);
  if (!dest) return fail(res, 404, 'Destino n\u00e3o encontrado.');

  const prep = await prepareNext(dest, body);
  if (prep.error) return fail(res, prep.error.status, prep.error.message, prep.error.extra);
  if (prep.empty) return res.status(200).json({ empty: true, skipped: prep.skipped });

  const { chosen, view, html, remaining, skippedInfo } = prep;
  const slugName = chosen.marketplaces ? chosen.marketplaces.name : null;

  if (dest.platform === 'whatsapp_manual') {
    const plain = toWhatsApp(html);
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
const BOT_PENDING_MAX_MS = 10 * 60 * 1000; // mensagem entregue ao robo e nao confirmada ha mais que isso: descarta

// ---- horario de funcionamento (hora de Brasilia = UTC-3, sem horario de verao desde 2019) ----
const BRT_OFFSET_MS = -3 * 3600 * 1000;
function parseHour(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
}
function inWindow(f, ms = Date.now()) {
  const from = Number.isInteger(f.hour_from) ? f.hour_from : null;
  const to = Number.isInteger(f.hour_to) ? f.hour_to : null;
  if (from === null || to === null || from === to) return true; // sem limite
  const h = new Date(ms + BRT_OFFSET_MS).getUTCHours();
  return from < to ? (h >= from && h < to) : (h >= from || h < to);
}
function nextWindowStart(f, ms = Date.now()) {
  const brt = new Date(ms + BRT_OFFSET_MS);
  let start = Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate(), f.hour_from, 0, 0) - BRT_OFFSET_MS;
  if (start <= ms) start += 24 * 3600 * 1000;
  return start;
}
// Intervalo com variacao de +-15%: mensagens em horario "redondo" demais chamam atencao do WhatsApp.
function jitteredMs(minutes) {
  return Math.max(Math.round(minutes * 60000 * (0.85 + Math.random() * 0.3)), 90 * 1000);
}

function fakeRes() {
  return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

async function jobsPayload() {
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from('dispatch_jobs').select('*');
  if (error) return { jobs: [], now, jobsError: error.message };
  // ultima vez que o robo do WhatsApp consultou o servidor (coluna criada pelo SQL 0004; sem ela, fica null)
  let botSeenAt = null;
  try {
    const r = await supabaseAdmin.from('dispatch_destinations').select('bot_seen_at').not('bot_seen_at', 'is', null).order('bot_seen_at', { ascending: false }).limit(1);
    if (!r.error && r.data && r.data[0]) botSeenAt = r.data[0].bot_seen_at;
  } catch { /* sem a coluna: segue */ }
  return { jobs: data || [], now, botSeenAt };
}

async function startJob(res, body) {
  const dest = await getDestination(body.destination_id);
  if (!dest) return fail(res, 404, 'Destino nao encontrado.');
  const isTelegram = dest.platform === 'telegram';
  // WhatsApp: 'bot' = robo envia sozinho; qualquer outra coisa = assistido (voce toca em enviar).
  const mode = isTelegram ? 'auto' : (body.mode === 'bot' ? 'bot' : 'assisted');
  const interval = Math.max(parseInt(body.interval_min, 10) || 0, (isTelegram || mode === 'bot') ? 2 : 1);
  const maxSends = Math.min(Math.max(parseInt(body.max_sends, 10) || 20, 1), 500);
  const footer = String(body.footer || '').slice(0, 120);
  const filters = {
    group_ids: Array.isArray(body.group_ids) ? body.group_ids : [],
    marketplace: body.marketplace || null,
    footer,
    hour_from: parseHour(body.hour_from),
    hour_to: parseHour(body.hour_to),
  };
  if (mode === 'bot') {
    const waGroup = String(body.wa_group || dest.chat_id || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!waGroup) return fail(res, 400, 'Informe o nome do grupo do WhatsApp (exatamente como aparece no WhatsApp) para o robo saber onde enviar.');
    filters.wa_group = waGroup;
    // guarda o nome no destino, para ja vir preenchido da proxima vez
    if (waGroup !== dest.chat_id) await supabaseAdmin.from('dispatch_destinations').update({ chat_id: waGroup }).eq('id', dest.id);
  }
  const nowIso = new Date().toISOString();
  const row = {
    destination_id: dest.id, mode, status: 'running',
    interval_min: interval, max_sends: maxSends, sent_count: 0, next_run_at: nowIso, claimed_at: null,
    filters,
    pending: null, last_event: mode === 'bot' ? 'Disparo iniciado. Aguardando o robo buscar a primeira mensagem.' : 'Disparo iniciado.', last_error: null, error_streak: 0, updated_at: nowIso,
  };
  const { error } = await supabaseAdmin.from('dispatch_jobs').upsert(row, { onConflict: 'destination_id' });
  if (error) {
    if (mode === 'bot' && /check constraint|violates/i.test(String(error.message || ''))) {
      return fail(res, 500, 'O banco ainda nao aceita o modo robo. Rode o SQL 0004_robo_whatsapp.sql no Supabase (SQL Editor) e tente de novo.');
    }
    return fail(res, 500, dbError(error));
  }
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
    if (!inWindow(f)) {
      const start = nextWindowStart(f);
      await finish({ next_run_at: new Date(start).toISOString(), last_event: `Fora do horario (${f.hour_from}h-${f.hour_to}h): retomo as ${f.hour_from}h.`, last_error: null });
      return;
    }
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
    .eq('status', 'running').neq('mode', 'bot').is('pending', null).lte('next_run_at', nowIso).limit(3);
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


// ---------------- WhatsApp 100% automatico (robo no notebook) ----------------
// O robo consulta bot_poll de tempos em tempos. Se ha um envio na hora, o servidor escolhe e confere a
// promocao, grava no registro (assim ela nunca se repete) e entrega a mensagem pronta; o robo envia no
// WhatsApp e confirma com bot_ack. Sem o robo ligado nada e enviado — o disparo apenas espera.

function botDeliver(job) {
  const p = job.pending;
  return { job_id: job.id, group: p.group, message: p.message, image_url: p.image_url || null, title: p.title };
}

async function prepareForBot(job) {
  const nowIso = () => new Date().toISOString();
  const release = (patch) => supabaseAdmin.from('dispatch_jobs').update({ claimed_at: null, updated_at: nowIso(), ...patch }).eq('id', job.id);
  try {
    const dest = await getDestination(job.destination_id);
    if (!dest) { await release({ status: 'stopped', last_error: 'Destino removido.' }); return null; }
    const f = job.filters || {};
    const group = String(f.wa_group || dest.chat_id || '').trim();
    if (!group) { await release({ status: 'stopped', last_error: 'Falta o nome do grupo do WhatsApp.' }); return null; }

    const prep = await prepareNext(dest, { group_ids: f.group_ids || [], marketplace: f.marketplace || null, footer: f.footer || '' });
    if (prep.error) {
      const code = prep.error.extra && prep.error.extra.code;
      if (code === 'daily_limit' || code === 'bad_link') { await release({ status: 'stopped', pending: null, last_error: prep.error.message }); return null; }
      await release({ next_run_at: new Date(Date.now() + 60000).toISOString(), last_error: prep.error.message });
      return null;
    }
    const skippedTxt = prep.skipped && prep.skipped.length ? ` (${prep.skipped.length} pulada(s) por problema no produto)` : '';
    if (prep.empty) {
      await release({ status: 'stopped', pending: null, last_event: 'A fila acabou: nao ha mais promocoes validas para esse filtro.' + skippedTxt });
      return null;
    }

    const message = toWhatsApp(prep.html);
    // Registra JA, antes do robo enviar: se o robo cair no meio, a promocao nao se repete depois.
    const { data: logRow } = await supabaseAdmin.from('dispatch_log')
      .insert({ destination_id: dest.id, promotion_id: prep.chosen.id, skipped: false, message }).select('id').maybeSingle();
    const imageUrl = prep.chosen.image_url && /^https:\/\//i.test(prep.chosen.image_url) ? prep.chosen.image_url : null;
    const pending = {
      log_id: logRow ? logRow.id : null, message, image_url: imageUrl, title: prep.chosen.title,
      coupon: prep.view.coupon || null, remaining: prep.remaining, group, prepared_at: nowIso(),
    };
    await release({ pending, last_event: `Entregue ao robo: ${String(prep.chosen.title).slice(0, 60)}${skippedTxt}`, last_error: null });
    return botDeliver({ id: job.id, pending });
  } catch (e) {
    await release({ next_run_at: new Date(Date.now() + 60000).toISOString(), last_error: e.message || 'erro inesperado' });
    return null;
  }
}

async function botPoll(res) {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  // "estou vivo": a tela mostra se o robo esta conectado (coluna do SQL 0004; se faltar, so ignora)
  await supabaseAdmin.from('dispatch_destinations').update({ bot_seen_at: nowIso }).eq('platform', 'whatsapp_manual');

  const { data: jobs, error } = await supabaseAdmin.from('dispatch_jobs').select('*')
    .eq('status', 'running').eq('mode', 'bot').order('next_run_at', { ascending: true });
  if (error) return fail(res, 500, dbError(error));

  let sleep = 60; // segundos ate o robo voltar a perguntar (no maximo 60, para reagir rapido a um novo "Iniciar")
  for (const job of jobs || []) {
    const f = job.filters || {};

    // 1) mensagem ja entregue e ainda sem confirmacao (robo reiniciou no meio): entrega de novo
    if (job.pending && job.pending.message) {
      const age = nowMs - new Date(job.pending.prepared_at).getTime();
      if (age < BOT_PENDING_MAX_MS) return res.status(200).json(botDeliver(job));
      await supabaseAdmin.from('dispatch_jobs').update({
        pending: null, claimed_at: null, next_run_at: new Date(nowMs + jitteredMs(job.interval_min)).toISOString(),
        last_event: 'O robo nao confirmou o envio anterior; segui para o proximo.', updated_at: nowIso,
      }).eq('id', job.id);
      continue;
    }

    // 2) ainda nao e a hora
    const due = new Date(job.next_run_at).getTime();
    if (due > nowMs) { sleep = Math.min(sleep, Math.max(Math.ceil((due - nowMs) / 1000), 5)); continue; }

    // 3) fora do horario escolhido: espera a janela abrir
    if (!inWindow(f, nowMs)) {
      await supabaseAdmin.from('dispatch_jobs').update({
        next_run_at: new Date(nextWindowStart(f, nowMs)).toISOString(),
        last_event: `Fora do horario (${f.hour_from}h-${f.hour_to}h): retomo as ${f.hour_from}h.`, updated_at: nowIso,
      }).eq('id', job.id);
      continue;
    }

    // 4) "trava" atomica: so uma consulta prepara o envio (evita mensagem em dobro)
    const stale = new Date(nowMs - CLAIM_STALE_MS).toISOString();
    const { data: claimed } = await supabaseAdmin.from('dispatch_jobs').update({ claimed_at: nowIso })
      .eq('id', job.id).eq('status', 'running').is('pending', null).lte('next_run_at', nowIso)
      .or(`claimed_at.is.null,claimed_at.lt.${stale}`).select().maybeSingle();
    if (!claimed) continue;

    const out = await prepareForBot(claimed);
    if (out) return res.status(200).json(out);
  }
  res.status(200).json({ idle: true, sleep });
}

// O robo avisa o resultado do envio.
async function botAck(res, body) {
  const { data: job, error } = await supabaseAdmin.from('dispatch_jobs').select('*').eq('id', body.job_id).maybeSingle();
  if (error) return fail(res, 500, dbError(error));
  if (!job || !job.pending) return res.status(200).json({ ok: true });
  const p = job.pending;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  if (body.ok) {
    const sent = job.sent_count + 1;
    const done = sent >= job.max_sends;
    await supabaseAdmin.from('dispatch_jobs').update({
      pending: null, claimed_at: null, sent_count: sent, status: done ? 'stopped' : 'running',
      next_run_at: new Date(nowMs + jitteredMs(job.interval_min)).toISOString(),
      last_event: (done ? `Meta de ${job.max_sends} envios atingida. ` : '') + `Enviado: ${String(p.title || '').slice(0, 70)}${p.coupon ? ` (cupom ${p.coupon})` : ''}`,
      last_error: null, error_streak: 0, updated_at: nowIso,
    }).eq('id', job.id);
    return res.status(200).json({ ok: true });
  }

  // falhou
  const reason = String(body.error || 'falha desconhecida').slice(0, 200);
  const fatal = body.fatal === true; // grupo nao encontrado / WhatsApp desconectado: nao adianta tentar de novo
  if (p.log_id) {
    // erro do robo (nao do produto): em falha fatal a promocao volta a ficar disponivel; nas demais, fica marcada como pulada
    if (fatal) await supabaseAdmin.from('dispatch_log').delete().eq('id', p.log_id);
    else await supabaseAdmin.from('dispatch_log').update({ skipped: true, message: `falhou no robo: ${reason}` }).eq('id', p.log_id);
  }
  const streak = (job.error_streak || 0) + 1;
  const stop = fatal || streak >= 5;
  await supabaseAdmin.from('dispatch_jobs').update({
    pending: null, claimed_at: null, status: stop ? 'stopped' : 'running',
    next_run_at: new Date(nowMs + 2 * 60000).toISOString(), error_streak: streak,
    last_error: stop && !fatal ? `${reason} (parei apos 5 falhas seguidas)` : reason, updated_at: nowIso,
  }).eq('id', job.id);
  res.status(200).json({ ok: true });
}

module.exports = async function handler(req, res) {
  if (LOAD_ERROR) return res.status(500).json({ error: LOAD_ERROR, version: VERSION });
  try {
    // Chave do robo (DISPATCH_BOT_KEY, definida na Vercel): quem chega so com a chave (sem login no painel)
    // pode apenas consultar/confirmar envios — nada de listar destinos, ler tokens ou mexer em disparos.
    const botKey = process.env.DISPATCH_BOT_KEY;
    const viaKey = !!botKey && req.headers['x-bot-key'] === botKey;
    if (viaKey && !(req.method === 'POST' && req.body && (req.body.action === 'bot_poll' || req.body.action === 'bot_ack'))) {
      return fail(res, 403, 'A chave do robo so pode usar bot_poll e bot_ack.');
    }

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
      case 'bot_poll': return await botPoll(res);
      case 'bot_ack': return await botAck(res, body);
      case 'send_next': return await sendNext(res, body);
      default: return fail(res, 400, 'A\u00e7\u00e3o inv\u00e1lida.');
    }
  } catch (err) {
    console.error('dispatch error', err);
    fail(res, 500, err.message || 'Erro inesperado no disparador.');
  }
};
