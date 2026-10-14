const { getSalePrice } = require('../../src/integrations/mercadolivre/client');
const { searchProductOffers, generateShortLink } = require('../../src/integrations/shopee/client');
const netshoesClient = require('../../src/integrations/netshoes/client');
const { supabaseAdmin } = require('../../src/core/database/supabaseClient');

const MIN_DISCOUNT_PCT = 10; // era 15 — baixei pra achar mais resultado em categorias mais de nicho

// Variedade na Shopee: a cada busca, sorteia a ordenação (1 relevância, 2 mais
// vendidos, 5 maior comissão) e a página (1 a 3). Sem isso, a mesma lista de
// campeões de venda volta todos os dias.
const SHOPEE_SORT_ROTATION = [1, 2, 5];

// Tempo máximo gasto buscando (a função da Vercel é configurada para 60s no vercel.json).
// Passou disso, a busca para de abrir novas consultas e avisa quantas ficaram pra próxima.
const SCAN_BUDGET_MS = 48000;
const NETSHOES_CONCURRENCY = 3;
// Quantos produtos pedir por palavra-chave e de quantas páginas sortear. Antes eram só 30 por
// palavra (sempre os mesmos 30 do topo) — por isso o total parecia "fixo" em ~120 produtos.
const NETSHOES_PAGE_SIZE = 100;
const NETSHOES_MAX_PAGE = 3;

// Netshoes: não existe mais um "10% fixo". O produto entra como promoção quando o preço atual
// está abaixo do preço "normal" dele, qualquer que seja o tamanho da queda (5%, 8%, 23%...).
// - Preço normal = mediana dos preços que o sistema registrou nos últimos 7 dias.
// - Produto visto pela primeira vez (sem histórico ainda): usa o preço "de" informado pela Netshoes.
// NETSHOES_MIN_DROP_PCT é só um piso para ignorar variação de centavos (ponha 0 se quiser tudo).
const NETSHOES_MIN_DROP_PCT = 2;
const NETSHOES_HISTORY_DAYS = 7;       // janela de comparação
const NETSHOES_HISTORY_KEEP_DAYS = 30; // histórico mais velho que isso é apagado
const NETSHOES_HISTORY_MIN_GAP_HOURS = 6; // não grava o mesmo produto de novo em menos de 6h

// GET  /api/scan/mercadolivre?groups=id1,id2,none
// POST /api/scan/mercadolivre   { groups: ['id1','id2','none'] }   (usado pelo painel — não tem limite de tamanho de URL)
// GET /api/scan/shopee?groups=id1,id2
// Antes eram 2 functions separadas — juntei num arquivo dinâmico só.
module.exports = async function handler(req, res) {
  const slug = req.query.marketplace;
  if (slug === 'mercadolivre') return scanMercadoLivre(req, res);
  if (slug === 'shopee') return scanShopee(req, res);
  if (slug === 'amazon') return scanAmazon(req, res);
  if (slug === 'netshoes') return scanNetshoes(req, res);
  res.status(404).json({ error: `Marketplace "${slug}" não suportado.` });
};

// ---------------- Utilitários de grupos ----------------

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normKey(value) {
  return cleanText(value).toLowerCase();
}

function splitKeywords(value) {
  return String(value || '').split(',').map(cleanText).filter(Boolean);
}

// Lista de ids de grupos escolhidos no painel (null = sem filtro, vale tudo).
function getGroupsParam(req) {
  if (req.method === 'POST') {
    const list = req.body && req.body.groups;
    if (Array.isArray(list)) return list.map(String).filter(Boolean);
    if (typeof list === 'string' && list) return list.split(',').filter(Boolean);
    return null;
  }
  return req.query.groups ? String(req.query.groups).split(',').filter(Boolean) : null;
}

// Tudo que tem o MESMO nome vira UM grupo só, com todas as palavras-chave somadas
// (sem repetir). Assim 30 linhas "Beleza" viram 1 grupo "Beleza" — e a mesma palavra
// nunca é buscada duas vezes.
function mergeGroupsByName(rows) {
  const sorted = [...(rows || [])].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  const map = new Map();
  for (const g of sorted) {
    const key = normKey(g.name);
    if (!map.has(key)) map.set(key, { id: g.id, ids: [], name: cleanText(g.name), keywords: [] });
    const merged = map.get(key);
    merged.ids.push(g.id);
    for (const kw of splitKeywords(g.search_keyword || g.name)) {
      if (!merged.keywords.some((k) => normKey(k) === normKey(kw))) merged.keywords.push(kw);
    }
  }
  return [...map.values()].map((m) => ({ ...m, search_keyword: m.keywords.join(', ') }));
}

// ---------------- Mercado Livre ----------------

async function scanMercadoLivre(req, res) {
  try {
    const { data: marketplace } = await supabaseAdmin
      .from('marketplaces')
      .select('id')
      .eq('slug', 'mercadolivre')
      .single();

    const { data: allProducts } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('marketplace_id', marketplace.id);

    const groupsParam = getGroupsParam(req);
    const products = groupsParam
      ? (allProducts || []).filter((p) => groupsParam.includes(p.watch_group_id || 'none'))
      : allProducts;

    let found = 0;
    const errors = [];

    for (const product of products || []) {
      try {
        found += await checkMlProduct(product, marketplace.id);
      } catch (err) {
        errors.push(`${product.source_item_id}: ${err.message}`);
        await supabaseAdmin.from('integration_logs').insert({
          marketplace_id: marketplace.id,
          level: 'error',
          message: `Falha ao checar ${product.source_item_id} (${product.title}): ${err.message}`,
        });
      }
    }

    res.status(200).json({
      ok: true,
      productsChecked: (products || []).length,
      promotionsFound: found,
      errors,
    });
  } catch (err) {
    res.status(500).json({ error: `Erro no servidor: ${err.message}` });
  }
}

async function checkMlProduct(product, marketplaceId) {
  const salePrice = await getSalePrice(product.source_item_id);

  await supabaseAdmin
    .from('products')
    .update({ last_checked_at: new Date().toISOString() })
    .eq('id', product.id);

  await supabaseAdmin.from('product_price_history').insert({ product_id: product.id, price: salePrice.amount });

  const hasPromotion =
    Boolean(salePrice.metadata?.promotion_id) ||
    (salePrice.regular_amount && salePrice.regular_amount > salePrice.amount);
  if (!hasPromotion) return 0;

  const discountRate = salePrice.regular_amount
    ? Number((((salePrice.regular_amount - salePrice.amount) / salePrice.regular_amount) * 100).toFixed(2))
    : null;

  const { data: existing } = await supabaseAdmin
    .from('promotions')
    .select('id, watch_group_id')
    .eq('product_id', product.id)
    .eq('current_price', salePrice.amount)
    .maybeSingle();

  if (existing) {
    await supabaseAdmin
      .from('promotions')
      .update({
        watch_group_id: existing.watch_group_id || product.watch_group_id || null,
        last_seen_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
    return 0;
  }

  await supabaseAdmin.from('promotions').insert({
    marketplace_id: marketplaceId,
    product_id: product.id,
    watch_group_id: product.watch_group_id || null,
    title: product.title,
    image_url: product.image_url,
    original_url: product.permalink,
    current_price: salePrice.amount,
    previous_price: salePrice.regular_amount || null,
    discount_rate: discountRate,
    source: 'watchlist_check',
    status: 'PENDING',
  });

  return 1;
}

// ---------------- Amazon ----------------
//
// A Creators API da Amazon (que substituiu a antiga PA-API, desativada em 2026)
// só libera consulta de catálogo depois que a conta de Associado tiver pelo
// menos 10 vendas qualificadas nos últimos 30 dias — é uma trava da própria
// Amazon, documentada por eles. Enquanto isso, não dá pra implementar a
// chamada de verdade sem arriscar inventar um endpoint que eu não confirmei.
// Assim que a conta atingir o requisito e a documentação completa abrir,
// essa função troca por uma implementação real.
async function scanAmazon(req, res) {
  try {
    const { data: marketplace } = await supabaseAdmin
      .from('marketplaces')
      .select('id')
      .eq('slug', 'amazon')
      .single();

    const { data: creds } = await supabaseAdmin
      .from('marketplace_credentials')
      .select('client_id, client_secret, extra_credential')
      .eq('marketplace_id', marketplace.id)
      .maybeSingle();

    if (!creds?.client_id || !creds?.client_secret || !creds?.extra_credential) {
      res.status(400).json({ error: 'Credenciais da Amazon não cadastradas. Vá em /marketplaces.html.' });
      return;
    }

    res.status(200).json({
      ok: true,
      productsChecked: 0,
      promotionsFound: 0,
      errors: [],
      note:
        'Credenciais salvas, mas a Creators API da Amazon só libera consulta depois que sua conta tiver 10 vendas qualificadas nos últimos 30 dias. Assim que isso acontecer, me avise pra eu implementar a busca de verdade.',
    });
  } catch (err) {
    res.status(500).json({ error: `Erro no servidor: ${err.message}` });
  }
}

// ---------------- Netshoes (via Rakuten Advertising) ----------------

async function scanNetshoes(req, res) {
  try {
    const { data: marketplace } = await supabaseAdmin
      .from('marketplaces')
      .select('id')
      .eq('slug', 'netshoes')
      .single();

    const { data: creds } = await supabaseAdmin
      .from('marketplace_credentials')
      .select('client_id, client_secret, extra_credential, extra_credential_2, extra_credential_3')
      .eq('marketplace_id', marketplace.id)
      .maybeSingle();

    if (!creds?.extra_credential || !creds?.extra_credential_2) {
      res.status(400).json({ error: 'Credenciais da Netshoes/Rakuten incompletas. Vá em /marketplaces.html.' });
      return;
    }

    const publisherId = creds.extra_credential;
    const mid = creds.extra_credential_2;

    // A busca de produtos da Rakuten usa até DOIS tokens:
    //  1) o token do Web Services (painel Rakuten: link "APIs" no rodapé da página), fixo;
    //  2) um token OAuth, gerado a cada busca (vale ~4h) com Client ID/Secret.
    const webServicesToken = creds.extra_credential_3;
    if (!webServicesToken) {
      res.status(400).json({
        error: 'Falta o Web Services Token da Rakuten (painel Rakuten: link "APIs" no rodapé da página). Cole em /marketplaces.html.',
      });
      return;
    }
    if (!creds.client_id || !creds.client_secret) {
      res.status(400).json({ error: 'Faltam o Client ID e o Client Secret da Rakuten em /marketplaces.html.' });
      return;
    }

    // Se o login automático falhar, ainda dá pra tentar as outras formas (só com o Web Services Token).
    // O motivo da falha entra no relatório final em vez de derrubar a busca inteira.
    const auth = { accessToken: null, webServicesToken, strategy: null };
    let tokenError = null;
    try {
      auth.accessToken = await netshoesClient.getAccessToken(creds.client_id, creds.client_secret, publisherId);
    } catch (err) {
      tokenError = err.message;
    }

    const { data: allGroups } = await supabaseAdmin.from('watch_groups').select('*');
    const groupsParam = getGroupsParam(req);
    const selectedRows = groupsParam ? (allGroups || []).filter((g) => groupsParam.includes(g.id)) : allGroups;
    const groups = mergeGroupsByName(selectedRows);

    if (groups.length === 0) {
      res.status(200).json({
        ok: true,
        groupsSearched: 0,
        productsChecked: 0,
        promotionsFound: 0,
        errors: [],
        note: 'Nenhum grupo selecionado — a Netshoes busca por palavra-chave, então marque pelo menos um grupo (não vale só "Sem grupo").',
      });
      return;
    }

    // Uma tarefa por palavra-chave (cada palavra só é buscada uma vez, mesmo que apareça em dois grupos).
    const tasks = [];
    const seenKeywords = new Set();
    for (const group of groups) {
      for (const keyword of group.keywords) {
        const key = normKey(keyword);
        if (seenKeywords.has(key)) continue;
        seenKeywords.add(key);
        tasks.push({ group, keyword });
      }
    }

    const startedAt = Date.now();
    const seenUrls = new Set();
    const errors = [];
    const emptySamples = [];
    let found = 0;
    let itemsSeen = 0;
    let withDiscount = 0;
    let done = 0;
    let skipped = 0;
    let loggedErrors = 0;
    let nextTask = 0;
    const totals = { withSale: 0, maxDiscount: 0, sample: null, withHistory: 0, historyError: null, newlyTracked: 0, withFeedDiscount: 0, parsedItems: 0 };

    async function worker() {
      while (nextTask < tasks.length) {
        const task = tasks[nextTask++];
        if (Date.now() - startedAt > SCAN_BUDGET_MS) { skipped += 1; continue; }
        try {
          const page = 1 + Math.floor(Math.random() * NETSHOES_MAX_PAGE);
          const items = await netshoesClient.searchProducts(auth, mid, task.keyword, { max: NETSHOES_PAGE_SIZE, page });
          done += 1;
          itemsSeen += items.length;
          if (!items.length && items.rawSample && emptySamples.length < 1) emptySamples.push(`"${task.keyword}": ${items.rawSample}`);
          const result = await processNetshoesItems(items, marketplace.id, task.group, publisherId, mid, seenUrls);
          found += result.found;
          withDiscount += result.withDiscount;
          totals.withSale += result.stats.withSale;
          totals.maxDiscount = Math.max(totals.maxDiscount, result.stats.maxDiscount);
          if (!totals.sample) totals.sample = result.stats.sample;
          totals.withHistory += result.stats.withHistory;
          totals.newlyTracked += result.stats.newlyTracked;
          totals.withFeedDiscount += result.stats.withFeedDiscount;
          totals.parsedItems += result.stats.parsedItems;
          if (!totals.historyError && result.stats.historyError) totals.historyError = result.stats.historyError;
        } catch (err) {
          errors.push(`${task.group.name} / "${task.keyword}": ${err.message}`);
          if (loggedErrors < 5) {
            loggedErrors += 1;
            await supabaseAdmin.from('integration_logs').insert({
              marketplace_id: marketplace.id,
              level: 'error',
              message: `Falha ao buscar produtos Netshoes para "${task.keyword}" (grupo ${task.group.name}) [web services token ${String(webServicesToken).length} caracteres]${tokenError ? ` [login automático falhou: ${tokenError}]` : ''}: ${err.message}`,
            });
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(NETSHOES_CONCURRENCY, tasks.length) }, worker));

    // Limpeza: histórico com mais de 30 dias não serve para nada (a comparação usa 7).
    if (!totals.historyError) {
      const keepSince = new Date(Date.now() - NETSHOES_HISTORY_KEEP_DAYS * 864e5).toISOString();
      await supabaseAdmin.from('promotion_price_history').delete().eq('marketplace_id', marketplace.id).lt('checked_at', keepSince);
    }

    const attempted = done + errors.length;
    const allFailed = attempted > 0 && errors.length === attempted;
    const parts = [];
    if (allFailed) {
      parts.push(`Todas as buscas da Netshoes falharam. ${errors[0]}${tokenError ? ` (login automático: ${tokenError})` : ''}`);
    } else if (itemsSeen === 0) {
      parts.push(`A Netshoes não devolveu nenhum produto para ${done} palavra(s)-chave.${emptySamples.length ? ` Exemplo da resposta recebida — ${emptySamples[0]}` : ''}`);
    } else if (found === 0) {
      const diag = `Diagnóstico: ${totals.parsedItems} produto(s) lidos, ${totals.withFeedDiscount} com preço "de" maior que o atual no feed da Netshoes, ${totals.withHistory} com histórico de preço (${totals.newlyTracked} registrados agora); maior queda vista: ${Math.round(totals.maxDiscount)}%.${totals.sample ? ` Exemplo da resposta: ${totals.sample}.` : ''}`;
      if (withDiscount) {
        parts.push(`A Netshoes devolveu ${itemsSeen} produto(s); ${withDiscount} em promoção, mas todos já estavam salvos no painel. ${diag}`);
      } else {
        parts.push(`A Netshoes devolveu ${itemsSeen} produto(s) pela busca de palavra-chave (a busca traz produtos do catálogo, não só os em promoção), mas nenhum está abaixo do preço normal (queda mínima de ${NETSHOES_MIN_DROP_PCT}%). ${diag}`);
      }
    }
    if (totals.historyError) parts.push(`Histórico de preços indisponível (${totals.historyError}). Rode o arquivo 0003_promotion_price_history.sql no Supabase; enquanto isso a comparação usa só o preço "de" da Netshoes.`);
    if (skipped) parts.push(`${skipped} palavra(s)-chave ficaram para a próxima busca (limite de tempo). Clique em buscar de novo para continuar.`);
    if (!allFailed && errors.length) parts.push(`${errors.length} palavra(s)-chave falharam: ${errors[0]}`);

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

// Converte "199.90", "199,90", "1.299,90" ou "1,299.90" em número.
// O último separador (ponto ou vírgula) é o decimal; o outro é separador de milhar.
function parsePrice(value) {
  if (value === null || value === undefined || value === '') return null;
  let s = String(value).replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function median(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Os campos vêm da leitura do XML da Rakuten (ver parseProductSearchXml no client.js).
// Grava em LOTE (poucas idas ao banco por palavra-chave, em vez de 2-3 por produto) —
// era isso que deixava a busca lenta a ponto de estourar o tempo da Vercel.
//
// Regra de promoção (sem porcentagem fixa):
//   preço normal = mediana dos preços registrados nos últimos 7 dias
//                  (se o produto ainda não tem histórico: o preço "de" da Netshoes)
//   é promoção quando preço atual < preço normal em pelo menos NETSHOES_MIN_DROP_PCT.
async function processNetshoesItems(items, marketplaceId, group, publisherId, mid, seenUrls) {
  const stats = { withSale: 0, maxDiscount: 0, sample: null, withHistory: 0, historyError: null, newlyTracked: 0, withFeedDiscount: 0, parsedItems: 0 };

  // 1) Lê os itens (um por link, mesmo que apareça em mais de uma palavra-chave)
  const parsed = [];
  for (const item of items) {
    if (!stats.sample) stats.sample = `${String(item.itemName || '').slice(0, 50)} (price: ${item.price}, saleprice: ${item.salePrice})`;
    const title = item.itemName;
    const productUrl = item.productUrl || item.linkUrl;
    const regularPrice = parsePrice(item.price);
    const price = parsePrice(item.salePrice) || regularPrice;

    if (!title || !productUrl || !price) continue; // resposta em formato inesperado — pula sem quebrar o resto
    if (seenUrls.has(productUrl)) continue;        // mesmo produto já tratado em outra palavra-chave
    seenUrls.add(productUrl);
    parsed.push({ title, productUrl, price, regularPrice, imageUrl: item.imageUrl || item.image || null });
  }
  stats.parsedItems = parsed.length;
  if (!parsed.length) return { found: 0, withDiscount: 0, stats };

  // 2) Histórico de preços desses links nos últimos 7 dias
  const historyByUrl = new Map(); // url -> { prices: [], lastAt: ms }
  const windowStart = new Date(Date.now() - NETSHOES_HISTORY_DAYS * 864e5).toISOString();
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
      const h = historyByUrl.get(row.product_url);
      h.prices.push(Number(row.price));
      h.lastAt = Math.max(h.lastAt, new Date(row.checked_at).getTime());
    }
  }

  // 3) Decide quem está em promoção
  const candidates = [];
  let withDiscount = 0;
  for (const c of parsed) {
    const h = historyByUrl.get(c.productUrl);
    // Duas fontes de "preço normal", vale a MAIOR que seja acima do preço atual:
    //  a) o preço "de" que a própria Netshoes informa no feed (price > saleprice);
    //  b) a mediana dos preços que o sistema registrou nos últimos 7 dias.
    // Antes, se o produto já tinha histórico, o preço "de" do feed era IGNORADO — e como o
    // histórico guardava o preço já promocional, a queda sempre dava 0%.
    const feedRef = c.regularPrice && c.regularPrice > c.price ? c.regularPrice : null;
    if (feedRef) stats.withFeedDiscount += 1;
    let historyRef = null;
    if (h && h.prices.length) {
      stats.withHistory += 1;
      const med = median(h.prices);
      if (med > c.price) historyRef = med;
    }
    const reference = Math.max(feedRef || 0, historyRef || 0) || null;

    const drop = reference && reference > c.price ? ((reference - c.price) / reference) * 100 : 0;
    if (drop > 0) {
      stats.withSale += 1;
      stats.maxDiscount = Math.max(stats.maxDiscount, drop);
    }
    if (drop <= 0 || drop < NETSHOES_MIN_DROP_PCT) continue;

    withDiscount += 1;
    candidates.push({ ...c, regularPrice: reference, discountRate: Number(drop.toFixed(2)) });
  }

  // 4) Registra o preço de hoje no histórico (só quem não foi registrado nas últimas 6h)
  if (historyOk) {
    const gapMs = NETSHOES_HISTORY_MIN_GAP_HOURS * 36e5;
    const nowMs = Date.now();
    const rows = parsed
      .filter((c) => { const h = historyByUrl.get(c.productUrl); return !h || nowMs - h.lastAt >= gapMs; })
      .map((c) => ({ marketplace_id: marketplaceId, product_url: c.productUrl, price: c.price }));
    if (rows.length) {
      const { error } = await supabaseAdmin.from('promotion_price_history').insert(rows);
      if (error) stats.historyError = error.message;
      else stats.newlyTracked = rows.length;
    }
  }

  if (!candidates.length) return { found: 0, withDiscount, stats };

  // 5) Quais desses links já estão salvos? (em blocos de 10 para não estourar o tamanho da consulta)
  const existingByUrl = new Map();
  for (const part of chunk(candidates.map((c) => c.productUrl), 10)) {
    const { data, error } = await supabaseAdmin
      .from('promotions')
      .select('id, original_url, watch_group_id, current_price')
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
    if (existing) {
      updates.push({ existing, c });
    } else {
      toInsert.push({
        marketplace_id: marketplaceId,
        watch_group_id: group.id,
        title: c.title,
        image_url: c.imageUrl,
        original_url: c.productUrl,
        current_price: c.price,
        previous_price: c.regularPrice,
        discount_rate: c.discountRate,
        source: 'netshoes_rakuten_api',
        status: 'PENDING',
        affiliate_url: netshoesClient.buildAffiliateLink(publisherId, mid, c.productUrl),
        affiliate_url_added_at: now,
      });
    }
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
        watch_group_id: existing.watch_group_id || group.id,
        last_seen_at: now,
      })
      .eq('id', existing.id)));
  }

  return { found: toInsert.length, withDiscount, stats };
}

// ---------------- Shopee ----------------

async function scanShopee(req, res) {
  try {
    const { data: marketplace } = await supabaseAdmin
      .from('marketplaces')
      .select('id')
      .eq('slug', 'shopee')
      .single();

    const { data: creds } = await supabaseAdmin
      .from('marketplace_credentials')
      .select('client_id, client_secret')
      .eq('marketplace_id', marketplace.id)
      .maybeSingle();

    if (!creds?.client_id || !creds?.client_secret) {
      res.status(400).json({ error: 'Credenciais da Shopee não cadastradas. Vá em /marketplaces.html.' });
      return;
    }

    const { data: allGroups } = await supabaseAdmin.from('watch_groups').select('*');
    const groupsParam = getGroupsParam(req);
    const selectedRows = groupsParam ? (allGroups || []).filter((g) => groupsParam.includes(g.id)) : allGroups;
    const groups = mergeGroupsByName(selectedRows);

    let found = 0;
    const errors = [];

    for (const group of groups || []) {
      try {
        // Suporta várias palavras-chave por grupo, separadas por vírgula —
        // busca cada uma separadamente, pra trazer produtos de fato distintos
        // dentro do nicho, em vez de uma palavra genérica dominada por um
        // único produto campeão de vendas.
        const keywords = (group.search_keyword || group.name)
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean);

        const perKeywordLimit = Math.max(10, Math.floor(40 / keywords.length));

        for (const keyword of keywords) {
          const sortType = SHOPEE_SORT_ROTATION[Math.floor(Math.random() * SHOPEE_SORT_ROTATION.length)];
          const page = 1 + Math.floor(Math.random() * 3);
          const offers = await searchProductOffers(creds.client_id, creds.client_secret, keyword, { limit: perKeywordLimit, sortType, page });
          for (const offer of offers) {
            found += await processShopeeOffer(offer, marketplace.id, group, creds);
          }
        }
      } catch (err) {
        errors.push(`${group.name}: ${err.message}`);
        await supabaseAdmin.from('integration_logs').insert({
          marketplace_id: marketplace.id,
          level: 'error',
          message: `Falha ao buscar ofertas Shopee para "${group.name}": ${err.message}`,
        });
      }
    }

    res.status(200).json({ ok: true, groupsSearched: (groups || []).length, promotionsFound: found, errors });
  } catch (err) {
    res.status(500).json({ error: `Erro no servidor: ${err.message}` });
  }
}

// Checa se o título do produto realmente tem a ver com a palavra-chave buscada.
// A busca da Shopee é por relevância ampla — alguns vendedores colocam palavras
// populares no título só pra aparecer em mais buscas ("keyword stuffing"). Isso
// descarta o caso óbvio de vazamento (ex: produto de cozinha aparecendo na
// busca de "corrida"), sem precisar de um filtro perfeito.
function titleMatchesKeyword(title, keyword) {
  const stopWords = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'com', 'para', 'em', 'a', 'o']);
  const words = keyword
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
  if (words.length === 0) return true; // palavra-chave só com termos curtos — não filtra
  const titleLower = title.toLowerCase();
  return words.some((w) => titleLower.includes(w));
}

async function processShopeeOffer(offer, marketplaceId, group, creds) {
  const discountRate = offer.priceDiscountRate || 0;
  if (discountRate < MIN_DISCOUNT_PCT) return 0;

  const keyword = group.search_keyword || group.name;
  if (!titleMatchesKeyword(offer.productName || '', keyword)) return 0;

  const originalUrl = offer.productLink || offer.offerLink;

  const { data: existing } = await supabaseAdmin
    .from('promotions')
    .select('id, watch_group_id')
    .eq('marketplace_id', marketplaceId)
    .eq('original_url', originalUrl)
    .maybeSingle();

  if (existing) {
    await supabaseAdmin
      .from('promotions')
      .update({
        current_price: offer.priceMin,
        discount_rate: discountRate,
        watch_group_id: existing.watch_group_id || group.id,
        last_seen_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
    return 0;
  }

  let affiliateUrl = null;
  try {
    affiliateUrl = await generateShortLink(creds.client_id, creds.client_secret, originalUrl, group.name);
  } catch (err) {
    await supabaseAdmin.from('integration_logs').insert({
      marketplace_id: marketplaceId,
      level: 'warn',
      message: `Oferta encontrada mas falhou ao gerar link de afiliado (${offer.itemId}): ${err.message}`,
    });
  }

  await supabaseAdmin.from('promotions').insert({
    marketplace_id: marketplaceId,
    watch_group_id: group.id,
    title: offer.productName,
    image_url: offer.imageUrl,
    original_url: originalUrl,
    current_price: offer.priceMin,
    previous_price: null,
    discount_rate: discountRate,
    source: 'shopee_affiliate_api',
    status: 'PENDING',
    affiliate_url: affiliateUrl,
    affiliate_url_added_at: affiliateUrl ? new Date().toISOString() : null,
  });

  return 1;
}
