const { supabaseAdmin } = require('../../src/core/database/supabaseClient');

// GET    /api/groups            -> lista todos
// POST   /api/groups            -> { name, search_keyword }
// DELETE /api/groups?id=...     -> remove um grupo
module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { data, error } = await supabaseAdmin.from('watch_groups').select('*').order('name');
      if (error) throw new Error(error.message);
      res.status(200).json({ groups: data || [] });
      return;
    }

    if (req.method === 'POST') {
      const { name, search_keyword } = req.body || {};
      if (!name || !search_keyword) {
        res.status(400).json({ error: 'Preencha o nome do grupo e a palavra-chave de busca.' });
        return;
      }

      const { data, error } = await supabaseAdmin
        .from('watch_groups')
        .insert({ name: name.trim(), search_keyword: search_keyword.trim() })
        .select()
        .single();

      if (error) {
        if (error.code === '23505') {
          res.status(400).json({ error: 'Já existe um grupo com esse nome.' });
          return;
        }
        throw new Error(error.message);
      }

      res.status(200).json({ ok: true, group: data });
      return;
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) {
        res.status(400).json({ error: 'id é obrigatório.' });
        return;
      }
      await supabaseAdmin.from('watch_groups').delete().eq('id', id);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Método não permitido.' });
  } catch (err) {
    res.status(500).json({ error: `Erro no servidor: ${err.message}` });
  }
};
