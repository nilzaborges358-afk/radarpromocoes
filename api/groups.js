const { supabaseAdmin } = require('../src/core/database/supabaseClient');
const { searchProductOffers } = require('../src/integrations/shopee/client');
const mlClient = require('../src/integrations/mercadolivre/client');
const netshoesClient = require('../src/integrations/netshoes/client');

// GET    /api/groups                          -> lista todos
// POST   /api/groups  { name, search_keyword } -> cria um grupo (se o nome já existir, soma as palavras-chave nele)
//        search_keyword aceita VÁRIAS palavras de uma vez, separadas por vírgula, ponto e vírgula ou quebra de linha
// POST   /api/groups  { action: 'test', keyword } -> testa uma busca (Shopee + Netshoes + Mercado Livre) sem salvar
// POST   /api/groups  { action: 'remove_keyword', ids, keyword } -> tira UMA palavra-chave de um grupo
// POST   /api/groups  { action: 'set_marketplaces', ids, marketplaces: ['shopee', ...] } -> em quais marketplaces o grupo roda
//        (criar grupo também aceita { marketplaces }; vazio/ausente = todos)
// DELETE /api/groups?id=a,b,c                 -> remove o grupo (todas as linhas com esses ids)
module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { data, error } = await supabaseAdmin.from('watch_groups').select('*').order('name');
      if (error) throw new Error(error.message);
      res.status(200).json({ groups: data || [] });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};

      if (body.action === 'test') {
        await testSearch(req, res, body.keyword);
        return;
      }

      if (body.action === 'remove_keyword') {
        await removeKeyword(res, body);
        return;
      }

      if (body.action === 'set_marketplaces') {
        await setMarketplaces(res, body);
        return;
      }

      const { name, search_keyword } = body;
      if (!name || !search_keyword) {
        res.status(400).json({ error: 'Preencha o nome do grupo e a palavra-chave de busca.' });
        return;
      }

      let chosenMarketplaces = null;
      if (body.marketplaces !== undefined && body.marketplaces !== null) {
        chosenMarketplaces = cleanMarketplaces(body.marketplaces);
        if (!chosenMarketplaces.length) {
          res.status(400).json({ error: 'Marque pelo menos um marketplace para o grupo rodar.' });
          return;
        }
      }

      const cleanName = normalizeText(name);
      const newKeywords = uniqueKeywords(splitKeywords(search_keyword));
      if (!newKeywords.length) {
        res.status(400).json({ error: 'Preencha ao menos uma palavra-chave de busca.' });
        return;
      }

      const { data: existing, error: listError } = await supabaseAdmin.from('watch_groups').select('*');
      if (listError) throw new Error(listError.message);

      // Mesmo nome (ignorando maiúsculas/minúsculas e espaços extras) = MESMO grupo.
      // Em vez de criar outra linha, as palavras-chave novas são somadas ao grupo que já existe.
      const sameName = sortByCreation((existing || []).filter((g) => normalizeKey(g.name) === normalizeKey(cleanName)));
      if (sameName.length) {
        const primary = sameName[0];
        const known = new Set();
        sameName.forEach((g) => splitKeywords(g.search_keyword || g.name).forEach((k) => known.add(normalizeKey(k))));

        const toAdd = newKeywords.filter((k) => !known.has(normalizeKey(k)));
        if (!toAdd.length) {
          res.status(400).json({ error: `O grupo "${normalizeText(primary.name)}" já tem essa(s) palavra(s)-chave.` });
          return;
        }

        const merged = [...splitKeywords(primary.search_keyword || primary.name), ...toAdd].join(', ');
        const { data, error } = await supabaseAdmin
          .from('watch_groups')
          .update({ search_keyword: merged })
          .eq('id', primary.id)
          .select()
          .single();
        if (error) throw new Error(error.message);

        res.status(200).json({
          ok: true,
          merged: true,
          added: toAdd.length,
          group: data,
          message: `Grupo "${normalizeText(primary.name)}" já existia — ${toAdd.length} palavra(s)-chave adicionada(s) a ele (os marketplaces dele continuam como estavam).`,
        });
        return;
      }

      const { data, error } = await supabaseAdmin
        .from('watch_groups')
        .insert({ name: cleanName, search_keyword: newKeywords.join(', '), ...(chosenMarketplaces ? { marketplaces: chosenMarketplaces } : {}) })
        .select()
        .single();

      if (error) {
        if (/marketplaces/i.test(error.message || '')) throw new Error('A coluna "marketplaces" ainda não existe no banco — rode o SQL 0008_grupos_por_marketplace.sql no Supabase.');
        if (error.code === '23505') {
          res.status(400).json({ error: 'Já existe um grupo com esse nome.' });
          return;
        }
        throw new Error(error.message);
      }

      res.status(200).json({ ok: true, group: data, message: `Grupo criado com ${newKeywords.length} palavra${newKeywords.length === 1 ? '' : 's'}-chave!` });
      return;
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) {
        res.status(400).json({ error: 'id é obrigatório.' });
        return;
      }
      // Aceita vários ids separados por vírgula (um grupo "unificado" pode ter várias linhas no banco).
      const ids = String(id).split(',').map((v) => v.trim()).filter(Boolean);
      const { error } = await supabaseAdmin.from('watch_groups').delete().in('id', ids);
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Método não permitido.' });
  } catch (err) {
    res.status(500).json({ error: `Erro no servidor: ${err.message}` });
  }
};

// Marketplaces em que um grupo pode rodar (os que buscam por palavra-chave).
const GROUP_MARKETPLACES = ['mercadolivre', 'shopee', 'netshoes'];

function cleanMarketplaces(list) {
  const arr = Array.isArray(list) ? list : String(list || '').split(',');
  return [...new Set(arr.map((v) => String(v).trim().toLowerCase()).filter((v) => GROUP_MARKETPLACES.includes(v)))];
}

// Muda em quais marketplaces um grupo roda (vale para todas as linhas do grupo "unificado").
async function setMarketplaces(res, body) {
  const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : [];
  const list = cleanMarketplaces(body.marketplaces);
  if (!ids.length) {
    res.status(400).json({ error: 'ids do grupo são obrigatórios.' });
    return;
  }
  if (!list.length) {
    res.status(400).json({ error: 'Deixe pelo menos um marketplace marcado.' });
    return;
  }
  const { error } = await supabaseAdmin.from('watch_groups').update({ marketplaces: list }).in('id', ids);
  if (error) {
    if (/marketplaces/i.test(error.message || '')) {
      throw new Error('A coluna "marketplaces" ainda não existe no banco — rode o SQL 0008_grupos_por_marketplace.sql no Supabase.');
    }
    throw new Error(error.message);
  }
  res.status(200).json({ ok: true, marketplaces: list });
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

// Aceita vírgula, ponto e vírgula e quebra de linha (dá para colar uma lista inteira, uma palavra por linha).
function splitKeywords(value) {
  return String(value || '').split(/[,;\n\r]+/).map((k) => normalizeText(k)).filter(Boolean);
}

function uniqueKeywords(list) {
  const seen = new Set();
  return list.filter((k) => {
    const key = normalizeKey(k);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortByCreation(rows) {
  return [...rows].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

// Tira uma palavra-chave de um grupo "unificado" (que pode estar espalhado em várias linhas do banco).
// Linhas que ficarem sem nenhuma palavra-chave são apagadas, e os produtos/promoções delas
// passam para uma linha que sobrou — nada fica "sem grupo" por causa disso.
async function removeKeyword(res, body) {
  const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : [];
  const target = normalizeKey(body.keyword);
  if (!ids.length || !target) {
    res.status(400).json({ error: 'Informe o grupo e a palavra-chave a remover.' });
    return;
  }

  const { data: found, error: findError } = await supabaseAdmin.from('watch_groups').select('*').in('id', ids);
  if (findError) throw new Error(findError.message);
  const rows = sortByCreation(found || []);

  const all = new Set();
  rows.forEach((r) => splitKeywords(r.search_keyword || r.name).forEach((k) => all.add(normalizeKey(k))));
  if (!all.has(target)) {
    res.status(400).json({ error: 'Essa palavra-chave não está mais no grupo. Recarregue a página.' });
    return;
  }
  if (all.size <= 1) {
    res.status(400).json({ error: 'Essa é a última palavra-chave do grupo — use "Remover grupo".' });
    return;
  }

  const plan = rows.map((r) => {
    const current = splitKeywords(r.search_keyword || r.name);
    return { row: r, current, kept: current.filter((k) => normalizeKey(k) !== target) };
  });
  const survivor = plan.find((p) => p.kept.length > 0).row;

  for (const p of plan) {
    if (p.kept.length === p.current.length) continue; // essa linha não tinha a palavra
    if (p.kept.length > 0) {
      const { error } = await supabaseAdmin.from('watch_groups').update({ search_keyword: p.kept.join(', ') }).eq('id', p.row.id);
      if (error) throw new Error(error.message);
    } else {
      await supabaseAdmin.from('products').update({ watch_group_id: survivor.id }).eq('watch_group_id', p.row.id);
      await supabaseAdmin.from('promotions').update({ watch_group_id: survivor.id }).eq('watch_group_id', p.row.id);
      const { error } = await supabaseAdmin.from('watch_groups').delete().eq('id', p.row.id);
      if (error) throw new Error(error.message);
    }
  }

  res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------------------------------
// TESTAR BUSCA — consulta TODOS os marketplaces que estão rodando (Shopee, Netshoes e Mercado Livre)
// ao mesmo tempo e mostra o resultado de cada um separado. Um que falhe ou não esteja conectado
// não derruba os outros: aparece só um aviso no lugar dele.
// ---------------------------------------------------------------------------------------------
const TEST_MAX_KEYWORDS = 4;     // testa no máximo as 4 primeiras palavras (rápido); o grupo salva todas
const TEST_TIMEOUT_MS = 14000;   // cada marketplace tem esse tempo; passou, mostra aviso e segue

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} demorou mais de ${Math.round(ms / 1000)}s para responder`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function toPrice(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let t = String(v).replace(/[^0-9.,-]/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function testShopee(keywords) {
  const { data: marketplace } = await supabaseAdmin.from('marketplaces').select('id').eq('slug', 'shopee').maybeSingle();
  if (!marketplace) return { status: 'skipped', message: 'Shopee ainda não está cadastrada.' };
  const { data: creds } = await supabaseAdmin
    .from('marketplace_credentials')
    .select('client_id, client_secret')
    .eq('marketplace_id', marketplace.id)
    .maybeSingle();
  if (!creds?.client_id || !creds?.client_secret) {
    return { status: 'skipped', message: 'Credenciais da Shopee não cadastradas (aba Marketplaces).' };
  }

  const perKeyword = Math.max(2, Math.floor(8 / keywords.length));
  const items = [];
  const errors = [];
  for (const kw of keywords) {
    try {
      const offers = await searchProductOffers(creds.client_id, creds.client_secret, kw, { limit: perKeyword });
      offers.slice(0, perKeyword).forEach((o) => items.push({
        keyword: kw, title: o.productName, image: o.imageUrl, price: toPrice(o.priceMin),
      }));
    } catch (err) { errors.push(`"${kw}": ${err.message}`); }
  }
  if (!items.length && errors.length) return { status: 'error', message: errors[0] };
  return { status: 'ok', items, message: errors.length ? `Algumas palavras falharam: ${errors.join(' | ')}` : null };
}

async function testNetshoes(keywords) {
  const { data: marketplace } = await supabaseAdmin.from('marketplaces').select('id').eq('slug', 'netshoes').maybeSingle();
  if (!marketplace) return { status: 'skipped', message: 'Netshoes ainda não está cadastrada.' };
  const { data: creds } = await supabaseAdmin
    .from('marketplace_credentials')
    .select('client_id, client_secret, extra_credential, extra_credential_2, extra_credential_3')
    .eq('marketplace_id', marketplace.id)
    .maybeSingle();
  if (!creds?.extra_credential || !creds?.extra_credential_2 || !creds?.extra_credential_3) {
    return { status: 'skipped', message: 'Credenciais da Netshoes/Rakuten incompletas (aba Marketplaces).' };
  }

  // Mesmo método do scan: token do Web Services + (se der) token OAuth.
  const auth = { accessToken: null, webServicesToken: creds.extra_credential_3, strategy: null };
  if (creds.client_id && creds.client_secret) {
    try { auth.accessToken = await netshoesClient.getAccessToken(creds.client_id, creds.client_secret, creds.extra_credential); } catch (e) { /* segue só com o Web Services Token */ }
  }

  const perKeyword = Math.max(2, Math.floor(8 / keywords.length));
  const items = [];
  const errors = [];
  for (const kw of keywords) {
    try {
      const found = await netshoesClient.searchProducts(auth, creds.extra_credential_2, kw, { max: Math.max(perKeyword, 10), page: 1 });
      found.slice(0, perKeyword).forEach((it) => items.push({
        keyword: kw, title: it.itemName, image: it.imageUrl || it.image || null,
        price: toPrice(it.salePrice) || toPrice(it.price),
      }));
    } catch (err) { errors.push(`"${kw}": ${err.message}`); }
  }
  if (!items.length && errors.length) return { status: 'error', message: errors[0] };
  return { status: 'ok', items, message: errors.length ? `Algumas palavras falharam: ${errors.join(' | ')}` : null };
}

async function testMercadoLivre(keywords) {
  const { token, reason } = await mlClient.getAccessToken(supabaseAdmin);
  if (!token) return { status: 'skipped', message: `Mercado Livre não conectado: ${reason || 'conecte a conta na aba Marketplaces.'}` };

  const perKeyword = Math.max(2, Math.floor(6 / keywords.length));
  const items = [];
  const errors = [];
  for (const kw of keywords) {
    try {
      const found = await mlClient.searchCatalogProducts({ q: kw, token, limit: perKeyword });
      const snaps = await Promise.allSettled(
        found.slice(0, perKeyword).map((f) => mlClient.getItemSnapshot({ id: f.id, kind: 'catalog', token }))
      );
      found.slice(0, perKeyword).forEach((f, i) => {
        const snap = snaps[i].status === 'fulfilled' ? snaps[i].value : null;
        items.push({
          keyword: kw, title: (snap && snap.title) || f.title || f.id,
          image: snap ? snap.thumbnail : null, price: snap ? snap.price : null,
        });
      });
    } catch (err) { errors.push(`"${kw}": ${err.message}`); }
  }
  if (!items.length && errors.length) return { status: 'error', message: errors[0] };
  return { status: 'ok', items, message: errors.length ? `Algumas palavras falharam: ${errors.join(' | ')}` : null };
}

async function testSearch(req, res, keyword) {
  const all = uniqueKeywords(splitKeywords(keyword));
  if (!all.length) {
    res.status(400).json({ error: 'Informe uma palavra-chave para testar.' });
    return;
  }
  const keywords = all.slice(0, TEST_MAX_KEYWORDS);

  const runners = [
    { slug: 'shopee', name: 'Shopee', run: testShopee },
    { slug: 'netshoes', name: 'Netshoes', run: testNetshoes },
    { slug: 'mercadolivre', name: 'Mercado Livre', run: testMercadoLivre },
  ];

  const results = await Promise.all(runners.map(async (r) => {
    try {
      const out = await withTimeout(r.run(keywords), TEST_TIMEOUT_MS, r.name);
      return { slug: r.slug, name: r.name, status: out.status, message: out.message || null, items: out.items || [] };
    } catch (err) {
      return { slug: r.slug, name: r.name, status: 'error', message: err.message, items: [] };
    }
  }));

  res.status(200).json({
    ok: true,
    tested: keywords,
    totalKeywords: all.length,
    results,
    // compatibilidade com a tela antiga (lista única)
    preview: results.flatMap((r) => r.items.map((o) => ({ title: o.title, image: o.image, price: o.price }))),
  });
}
