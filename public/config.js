// A anon/publishable key é segura para expor no frontend — ela só enxerga o que a RLS libera
// (no nosso caso, só leitura e atualização de status da tabela `promotions`). Nunca coloque
// a service_role/secret key aqui.
window.RADAR_CONFIG = {
  SUPABASE_URL: 'https://kwbyzsenfsqrglxlxapa.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_8Mo6qp7KXNVLCK89udcPQA_pgoODJBF',
};
