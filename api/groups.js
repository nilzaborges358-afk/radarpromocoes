const { supabaseAdmin } = require('../src/core/database/supabaseClient');
const { searchProductOffers } = require('../src/integrations/shopee/client');

// GET    /api/groups                          -> lista todos
// POST   /api/groups  { name, search_keyword } -> cria um grupo (se o nome já existir, soma as palavras-chave nele)
// POST   /api/groups  { action: 'test', keyword } -> testa uma busca sem salvar
// POST   /api/groups  { action: 'remove_keyword', ids, keyword } -> tira UMA palavra-chave de um grupo
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

      const { name, search_keyword } = body;
      if (!name || !search_keyword) {
        res.status(400).json({ error: 'Preencha o nome do grupo e a palavra-chave de busca.' });
        return;
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
          message: `Grupo "${normalizeText(primary.name)}" já existia — ${toAdd.length} palavra(s)-chave adicionada(s) a ele.`,
        });
        return;
      }

      const { data, error } = await supabaseAdmin
        .from('watch_groups')
        .insert({ name: cleanName, search_keyword: newKeywords.join(', ') })
        .select()
        .single();

      if (error) {
        if (error.code === '23505') {
          res.status(400).json({ error: 'Já existe um grupo com esse nome.' });
          return;
        }
        throw new Error(error.message);
      }

      res.status(200).json({ ok: true, group: data, message: 'Grupo criado!' });
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

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function splitKeywords(value) {
  return String(value || '').split(',').map((k) => normalizeText(k)).filter(Boolean);
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

async function testSearch(req, res, keyword) {
  if (!keyword) {
    res.status(400).json({ error: 'Informe uma palavra-chave para testar.' });
    return;
  }

  const { data: marketplace } = await supabaseAdmin.from('marketplaces').select('id').eq('slug', 'shopee').single();
  const { data: creds } = await supabaseAdmin
    .from('marketplace_credentials')
    .select('client_id, client_secret')
    .eq('marketplace_id', marketplace.id)
    .maybeSingle();

  if (!creds?.client_id || !creds?.client_secret) {
    res.status(400).json({ error: 'Credenciais da Shopee não cadastradas ainda. Vá em /marketplaces.html.' });
    return;
  }

  const keywords = keyword.split(',').map((k) => k.trim()).filter(Boolean);
  const perKeywordLimit = Math.max(2, Math.floor(8 / keywords.length));

  let allOffers = [];
  for (const kw of keywords) {
    const offers = await searchProductOffers(creds.client_id, creds.client_secret, kw, { limit: perKeywordLimit });
    allOffers = allOffers.concat(offers);
  }

  res.status(200).json({
    ok: true,
    preview: allOffers.map((o) => ({ title: o.productName, image: o.imageUrl, price: o.priceMin, discount: o.priceDiscountRate })),
  });
}
