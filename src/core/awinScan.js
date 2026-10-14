const awinClient = require('../integrations/awin/client');
const { getAwinContext, loadAwinCoupons } = require('./awin');
const { bestNetshoesCoupon } = require('./coupons');

// Busca de promoções da Riachuelo (Awin). Segue as MESMAS regras da Netshoes:
//  - promoção = preço atual abaixo do preço "normal" (o maior entre o preço "de" do feed e a
//    mediana dos preços que o sistema registrou nos últimos 7 dias);
//  - produto sem queda, mas com cupom ativo que vale para ele = oferta "produto + cupom";
//  - link de afiliado montado na hora; promoção entra como PENDING no painel.
// Diferença: a Awin não tem "busca por palavra-chave" — ela entrega o catálogo (feed). Por isso o feed
// é baixado UMA vez por busca e cada palavra-chave dos grupos é procurada dentro dele.
const AWIN_MIN_DROP_PCT = 2;
const AWIN_HISTORY_DAYS = 7;
const AWIN_HISTORY_KEEP_DAYS = 30;
const AWIN_HISTORY_MIN_GAP_HOURS = 6;
const AWIN_COUPON_MIN_PCT = 5;
const AWIN_COUPON_MAX_PER_SCAN = 20;
const AWIN_PER_KEYWORD = 100;          // produtos analisados por palavra-chave
const AWIN_FEED_DOWNLOADS_PER_HOUR = 4; // a Awin aceita 5 downloads iguais por hora; paro em 4
const AWIN_CONCURRENCY = 3;
const SCAN_BUDGET_MS = 48000;

const STOP_WORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'com', 'para', 'em', 'a', 'o', 'um', 'uma']);

function norm(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function keywordTokens(keyword) {
  return norm(keyword).split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

// Todas as palavras da palavra-chave precisam aparecer (aceita plural: "tenis" casa com "tenis" e "tenises"...).
function textHasAll(text, tokens) {
  if (!tokens.length) return false;
  return tokens.every((t) => text.includes(t) || (t.length >= 4 && t.endsWith('s') && text.includes(t.slice(0, -1))));
}

function pick(row, ...names) {
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function feedDownloadsLastHour(supabase, marketplaceId) {
  try {
    const since = new Date(Date.now() - 3600 * 1000).toISOString();
    const { count, error } = await supabase
      .from('integration_logs')
      .select('id', { count: 'exact', head: true })
      .eq('marketplace_id', marketplaceId)
      .eq('level', 'info')
      .like('message', 'awin_feed_download%')
      .gte('created_at', since);
    return error ? 0 : (count || 0);
  } catch { return 0; }
}

async function scanRiachuelo(req, res, h) {
  const { supabaseAdmin, getGroupsParam, mergeGroupsByName, parsePrice, chunk, median, normKey } = h;
  try {
    const ctx = await getAwinContext(supabaseAdmin, { needFeed: true });
    if (ctx.error) { res.status(400).json({ error: ctx.error }); return; }
    const marketplaceId = ctx.marketplaceId;

    const { data: allGroups } = await supabaseAdmin.from('watch_groups').select('*');
    const groupsParam = getGroupsParam(req);
    const selectedRows = groupsParam ? (allGroups || []).filter((g) => groupsParam.includes(g.id)) : allGroups;
    const groups = mergeGroupsByName(selectedRows);
    if (groups.length === 0) {
      res.status(200).json({ ok: true, groupsSearched: 0, productsChecked: 0, promotionsFound: 0, errors: [],
        note: 'Nenhum grupo selecionado — a Riachuelo busca por palavra-chave dentro do catálogo, então marque pelo menos um grupo (não vale só "Sem grupo").' });
      return;
    }

    // Uma tarefa por palavra-chave (cada palavra só é procurada uma vez).
    const tasks = [];
    const seenKeywords = new Set();
    for (const group of groups) {
      for (const keyword of group.keywords) {
        const key = normKey(keyword);
        if (seenKeywords.has(key)) continue;
        seenKeywords.add(key);
        const tokens = keywordTokens(keyword);
        if (tokens.length) tasks.push({ group, keyword, tokens, matches: [] });
      }
    }
    if (!tasks.length) {
      res.status(200).json({ ok: true, groupsSearched: groups.length, productsChecked: 0, promotionsFound: 0, errors: [], note: 'Os grupos escolhidos não têm palavras-chave válidas.' });
      return;
    }

    // Feed: acha a URL de download e respeita o limite de downloads por hora da Awin.
    let feed;
    try {
      feed = await awinClient.resolveFeed(ctx.feedKey, { advertiserId: ctx.advertiserId, feedId: ctx.feedId, nameHint: 'riachuelo' });
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    const used = await feedDownloadsLastHour(supabaseAdmin, marketplaceId);
    if (used >= AWIN_FEED_DOWNLOADS_PER_HOUR) {
      res.status(429).json({ error: `A Awin só aceita 5 downloads do mesmo feed por hora e este sistema já baixou ${used} na última hora. Espere um pouco e busque de novo.` });
      return;
    }
    await supabaseAdmin.from('integration_logs').insert({ marketplace_id: marketplaceId, level: 'info', message: `awin_feed_download feed ${feed.feedId}` });

    const startedAt = Date.now();
    let feedStats;
    let feedRows = 0;
    let outOfStock = 0;
    try {
      feedStats = await awinClient.streamFeed(feed.url, (row) => {
        feedRows += 1;
        const title = pick(row, 'product_name', 'name');
        const current = parsePrice(pick(row, 'search_price', 'store_price', 'price'));
        const link = pick(row, 'merchant_deep_link', 'product_url', 'url');
        if (!title || !current || !link) return false;
        const stock = pick(row, 'in_stock', 'stock_status');
        if (stock && /^(0|false|no|nao|não|out)/i.test(stock)) { outOfStock += 1; return false; }

        const old = parsePrice(pick(row, 'product_price_old')) || 0;
        const rrp = parsePrice(pick(row, 'rrp_price')) || 0;
        const store = parsePrice(pick(row, 'store_price')) || 0;
        const regular = Math.max(old, rrp, store > current ? store : 0);
        const category = pick(row, 'category_name', 'merchant_category', 'merchant_product_category_path');
        const brand = pick(row, 'brand_name');
        const text = norm(`${title} ${brand || ''} ${category || ''}`);

        for (const task of tasks) {
          if (textHasAll(text, task.tokens)) {
            task.matches.push({
              itemName: title,
              productUrl: link,
              price: regular > current ? String(regular) : String(current),
              salePrice: String(current),
              imageUrl: pick(row, 'merchant_image_url', 'aw_image_url', 'image_url'),
              category,
              _feedDrop: regular > current ? ((regular - current) / regular) * 100 : 0,
            });
            break; // o produto fica no primeiro grupo que casar
          }
        }
        return false;
      });
    } catch (err) {
      res.status(502).json({ error: `Não consegui baixar o feed da Riachuelo: ${err.message}` });
      return;
    }

    // Cupons ativos (falha aqui não derruba a busca).
    let couponList = [];
    let couponNote = null;
    try {
      const loaded = await loadAwinCoupons(ctx);
      if (loaded.error) couponNote = loaded.error; else couponList = loaded.coupons.filter((c) => c.code);
    } catch (err) { couponNote = err.message; }
    const couponCtx = { list: couponList, left: AWIN_COUPON_MAX_PER_SCAN, deals: 0 };

    const seenUrls = new Set();
    const errors = [];
    let found = 0; let withDiscount = 0; let itemsSeen = 0; let done = 0; let skipped = 0; let nextTask = 0;
    const totals = { withSale: 0, maxDiscount: 0, withHistory: 0, historyError: null, newlyTracked: 0, withFeedDiscount: 0, parsedItems: 0, changed: 0, oldestMs: 0, matchedKeywords: 0 };

    async function worker() {
      while (nextTask < tasks.length) {
        const task = tasks[nextTask++];
        if (!task.matches.length) { done += 1; continue; }
        if (Date.now() - startedAt > SCAN_BUDGET_MS) { skipped += 1; continue; }
        totals.matchedKeywords += 1;
        try {
          // Os que já vêm com preço "de" maior primeiro; o resto sorteado, para variar a cada busca.
          const withDrop = task.matches.filter((m) => m._feedDrop > 0).sort((a, b) => b._feedDrop - a._feedDrop);
          const rest = shuffle(task.matches.filter((m) => !(m._feedDrop > 0)));
          const items = [...withDrop, ...rest].slice(0, AWIN_PER_KEYWORD);
          itemsSeen += items.length;
          const r = await processAwinItems(items, ctx, task.group, seenUrls, couponCtx, h);
          done += 1;
          found += r.found; withDiscount += r.withDiscount;
          const s = r.stats;
          totals.withSale += s.withSale; totals.maxDiscount = Math.max(totals.maxDiscount, s.maxDiscount);
          totals.withHistory += s.withHistory; totals.newlyTracked += s.newlyTracked; totals.withFeedDiscount += s.withFeedDiscount;
          totals.parsedItems += s.parsedItems; totals.changed += s.changed;
          if (s.oldestMs && (!totals.oldestMs || s.oldestMs < totals.oldestMs)) totals.oldestMs = s.oldestMs;
          if (!totals.historyError && s.historyError) totals.historyError = s.historyError;
        } catch (err) {
          errors.push(`${task.group.name} / "${task.keyword}": ${err.message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(AWIN_CONCURRENCY, tasks.length) }, worker));

    if (!totals.historyError) {
      const keepSince = new Date(Date.now() - AWIN_HISTORY_KEEP_DAYS * 864e5).toISOString();
      await supabaseAdmin.from('promotion_price_history').delete().eq('marketplace_id', marketplaceId).lt('checked_at', keepSince);
    }

    const noMatch = tasks.filter((t) => !t.matches.length).map((t) => t.keyword);
    const couponDiag = couponNote
      ? ` Cupons da Riachuelo: não consegui ler (${couponNote}).`
      : ` Cupons ativos com código: ${couponList.length}${couponCtx.deals ? `; ${couponCtx.deals} oferta(s) criada(s) por cupom` : ''}.`;
    const feedDiag = `Feed da Riachuelo: ${feedRows} produto(s) lido(s)${outOfStock ? `, ${outOfStock} sem estoque ignorado(s)` : ''}${feed.lastImported ? `, atualizado em ${feed.lastImported}` : ''}.`;
    const parts = [];
    if (itemsSeen === 0) {
      parts.push(`${feedDiag} Nenhum produto do catálogo casou com as palavras-chave escolhidas (${noMatch.slice(0, 5).join(', ')}${noMatch.length > 5 ? '…' : ''}). Use palavras que apareçam no nome do produto na Riachuelo (ex: vestido, jaqueta, tênis).${couponDiag}`);
    } else if (found === 0) {
      const historyDays = totals.oldestMs ? Math.max(0, Math.floor((Date.now() - totals.oldestMs) / 864e5)) : 0;
      const diag = `Diagnóstico: ${totals.parsedItems} produto(s) analisados, ${totals.withFeedDiscount} com preço "de" maior que o atual no feed, ${totals.withHistory} com histórico de preço (${totals.newlyTracked} registrados agora; histórico mais antigo: ${historyDays} dia(s)); maior queda vista: ${Math.round(totals.maxDiscount)}%.`;
      parts.push(withDiscount
        ? `${feedDiag} ${withDiscount} produto(s) em promoção, mas todos já estavam salvos no painel. ${diag}${couponDiag}`
        : `${feedDiag} Nenhum produto está abaixo do preço normal (queda mínima de ${AWIN_MIN_DROP_PCT}%) nem tem cupom que valha para ele. ${diag}${couponDiag}`);
    }
    if (found > 0) parts.push(`${feedDiag}${couponNote ? ` Aviso: não consegui ler os cupons da Riachuelo (${couponNote}).` : ''}${couponCtx.deals ? ` ${couponCtx.deals} das ofertas vieram de cupom ativo.` : ''}`);
    if (noMatch.length && itemsSeen > 0) parts.push(`${noMatch.length} palavra(s)-chave não casaram com nenhum produto: ${noMatch.slice(0, 5).join(', ')}.`);
    if (totals.historyError) parts.push(`Histórico de preços indisponível (${totals.historyError}). Rode o arquivo 0003_promotion_price_history.sql no Supabase.`);
    if (skipped) parts.push(`${skipped} palavra(s)-chave ficaram para a próxima busca (limite de tempo).`);
    if (errors.length) parts.push(`${errors.length} palavra(s)-chave falharam: ${errors[0]}`);

    res.status(200).json({
      ok: true,
      groupsSearched: groups.length,
      keywordsSearched: done,
      productsChecked: itemsSeen,
      promotionsFound: found,
      errors,
      note: parts.length ? parts.join(' ') : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: `Erro no servidor: ${err.message}` });
  }
}

// Mesma regra de decisão do processNetshoesItems, trocando só a origem dos dados e o link de afiliado.
async function processAwinItems(items, ctx, group, seenUrls, couponCtx, h) {
  const { supabaseAdmin, parsePrice, chunk, median } = h;
  const marketplaceId = ctx.marketplaceId;
  const stats = { withSale: 0, maxDiscount: 0, withHistory: 0, historyError: null, newlyTracked: 0, withFeedDiscount: 0, parsedItems: 0, changed: 0, oldestMs: 0 };

  const parsed = [];
  for (const item of items) {
    const productUrl = item.productUrl;
    const regularPrice = parsePrice(item.price);
    const price = parsePrice(item.salePrice) || regularPrice;
    if (!item.itemName || !productUrl || !price) continue;
    if (seenUrls.has(productUrl)) continue;
    seenUrls.add(productUrl);
    parsed.push({ title: item.itemName, productUrl, price, regularPrice, imageUrl: item.imageUrl || null, category: item.category || null });
  }
  stats.parsedItems = parsed.length;
  if (!parsed.length) return { found: 0, withDiscount: 0, stats };

  // Histórico de preços dos últimos 7 dias
  const historyByUrl = new Map();
  const windowStart = new Date(Date.now() - AWIN_HISTORY_DAYS * 864e5).toISOString();
  let historyOk = true;
  for (const part of chunk(parsed.map((c) => c.productUrl), 10)) {
    const { data, error } = await supabaseAdmin
      .from('promotion_price_history')
      .select('product_url, price, checked_at')
      .eq('marketplace_id', marketplaceId)
      .in('product_url', part)
      .gte('checked_at', windowStart);
    if (error) { historyOk = false; stats.historyError = error.message; break; }
    for (const row of data || []) {
      if (!historyByUrl.has(row.product_url)) historyByUrl.set(row.product_url, { prices: [], lastAt: 0 });
      const hh = historyByUrl.get(row.product_url);
      hh.prices.push(Number(row.price));
      const at = new Date(row.checked_at).getTime();
      hh.lastAt = Math.max(hh.lastAt, at);
      if (!stats.oldestMs || at < stats.oldestMs) stats.oldestMs = at;
    }
  }

  // Quem está em promoção
  const candidates = [];
  const couponCandidates = [];
  let withDiscount = 0;
  for (const c of parsed) {
    const hh = historyByUrl.get(c.productUrl);
    const feedRef = c.regularPrice && c.regularPrice > c.price ? c.regularPrice : null;
    if (feedRef) stats.withFeedDiscount += 1;
    let historyRef = null;
    if (hh && hh.prices.length) {
      stats.withHistory += 1;
      const med = median(hh.prices);
      if (med > c.price) historyRef = med;
      if (hh.prices.some((p) => Math.abs(p - c.price) >= 0.01)) stats.changed += 1;
    }
    const reference = Math.max(feedRef || 0, historyRef || 0) || null;
    const drop = reference && reference > c.price ? ((reference - c.price) / reference) * 100 : 0;
    if (drop > 0) { stats.withSale += 1; stats.maxDiscount = Math.max(stats.maxDiscount, drop); }

    if (drop <= 0 || drop < AWIN_MIN_DROP_PCT) {
      if (couponCtx && couponCtx.list.length) {
        const best = bestNetshoesCoupon(couponCtx.list, { title: c.title, price: c.price, category: c.category });
        if (best) {
          const pct = (best.discount / c.price) * 100;
          if (pct >= AWIN_COUPON_MIN_PCT) {
            couponCandidates.push({ ...c, regularPrice: c.price, price: best.finalPrice, discountRate: Number(pct.toFixed(2)), source: 'riachuelo_coupon', _pct: pct });
          }
        }
      }
      continue;
    }
    withDiscount += 1;
    candidates.push({ ...c, regularPrice: reference, discountRate: Number(drop.toFixed(2)), source: 'riachuelo_awin_feed' });
  }

  if (couponCandidates.length && couponCtx.left > 0) {
    couponCandidates.sort((a, b) => b._pct - a._pct);
    const take = couponCandidates.slice(0, couponCtx.left);
    couponCtx.left -= take.length;
    couponCtx.deals += take.length;
    withDiscount += take.length;
    candidates.push(...take);
  }

  // Registra o preço de hoje (só quem não foi registrado nas últimas 6h)
  if (historyOk) {
    const gapMs = AWIN_HISTORY_MIN_GAP_HOURS * 36e5;
    const nowMs = Date.now();
    const rows = parsed
      .filter((c) => { const hh = historyByUrl.get(c.productUrl); return !hh || nowMs - hh.lastAt >= gapMs; })
      .map((c) => ({ marketplace_id: marketplaceId, product_url: c.productUrl, price: c.price }));
    if (rows.length) {
      const { error } = await supabaseAdmin.from('promotion_price_history').insert(rows);
      if (error) stats.historyError = error.message; else stats.newlyTracked = rows.length;
    }
  }

  if (!candidates.length) return { found: 0, withDiscount, stats };

  // Quais já estão salvos?
  const existingByUrl = new Map();
  for (const part of chunk(candidates.map((c) => c.productUrl), 10)) {
    const { data, error } = await supabaseAdmin
      .from('promotions')
      .select('id, original_url, watch_group_id')
      .eq('marketplace_id', marketplaceId)
      .in('original_url', part);
    if (error) throw new Error(`banco de dados: ${error.message}`);
    (data || []).forEach((row) => existingByUrl.set(row.original_url, row));
  }

  const now = new Date().toISOString();
  const toInsert = [];
  const updates = [];
  for (const c of candidates) {
    const existing = existingByUrl.get(c.productUrl);
    if (existing) { updates.push({ existing, c }); continue; }
    toInsert.push({
      marketplace_id: marketplaceId,
      watch_group_id: group.id,
      title: c.title,
      image_url: c.imageUrl,
      original_url: c.productUrl,
      current_price: c.price,
      previous_price: c.regularPrice,
      discount_rate: c.discountRate,
      source: c.source,
      status: 'PENDING',
      last_seen_at: now,
      affiliate_url: awinClient.buildAffiliateLink(ctx.publisherId, ctx.advertiserId, c.productUrl),
      affiliate_url_added_at: now,
    });
  }

  if (toInsert.length) {
    const { error } = await supabaseAdmin.from('promotions').insert(toInsert);
    if (error) throw new Error(`banco de dados: ${error.message}`);
  }
  for (const part of chunk(updates, 10)) {
    await Promise.all(part.map(({ existing, c }) => supabaseAdmin
      .from('promotions')
      .update({
        current_price: c.price,
        previous_price: c.regularPrice,
        discount_rate: c.discountRate,
        source: c.source,
        watch_group_id: existing.watch_group_id || group.id,
        last_seen_at: now,
      })
      .eq('id', existing.id)));
  }

  return { found: toInsert.length, withDiscount, stats };
}

module.exports = { scanRiachuelo, keywordTokens, textHasAll };
