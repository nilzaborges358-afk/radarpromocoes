const { createClient } = require('@supabase/supabase-js');

// Service role: usado só no backend (webhooks, cron, OAuth callback).
// NUNCA importar este arquivo em código que roda no navegador.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

module.exports = { supabaseAdmin };
