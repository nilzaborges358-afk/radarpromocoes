// A anon key é segura para expor no frontend — ela só enxerga o que a RLS libera
// (no nosso caso, só leitura da tabela `promotions`). Nunca coloque a service_role aqui.
window.RADAR_CONFIG = {
  SUPABASE_URL: 'https://SEU-PROJETO.supabase.co',
  SUPABASE_ANON_KEY: 'SUA_ANON_KEY_AQUI',
};
