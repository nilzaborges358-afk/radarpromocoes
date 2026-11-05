// Ciclo de vida da promoção: "promoção finalizada".
//
// Em vez de apagar ou esconder uma promoção que acabou, o sistema grava ended_at + ended_reason.
// O status (PENDING / AFFILIATED / IGNORED) continua como estava — assim você ainda sabe que afiliou aquele produto.
//   - termina quando: o preço voltou a subir (visto numa busca ou conferido pelo Disparador),
//                     o anúncio sumiu, ou o produto não aparece mais nas buscas há vários dias;
//   - volta a ficar ativa sozinha se o produto reaparecer em promoção (ended_at volta a null).
// Precisa do SQL 0005_ciclo_de_vida.sql. Sem ele, tudo aqui vira "não faz nada" (nada quebra).

const STALE_HOURS = 96; // sem ser vista pelas buscas por 4 dias = promoção finalizada

let supportCache = { at: 0, ok: null };

async function endedSupported(supabase) {
  if (supportCache.ok !== null && Date.now() - supportCache.at < 60000) return supportCache.ok;
  try {
    const { error } = await supabase.from('promotions').select('ended_at').limit(1);
    supportCache = { at: Date.now(), ok: !error };
  } catch { supportCache = { at: Date.now(), ok: false }; }
  return supportCache.ok;
}

// Campos para "reativar" uma promoção que reapareceu (vazio se o banco ainda não tem a coluna).
async function reviveFields(supabase) {
  return (await endedSupported(supabase)) ? { ended_at: null, ended_reason: null } : {};
}

// Marca como finalizadas (só as que ainda não estavam). Devolve quantas.
async function markEnded(supabase, ids, reason) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length || !(await endedSupported(supabase))) return 0;
  const now = new Date().toISOString();
  let n = 0;
  for (let i = 0; i < list.length; i += 100) {
    const { data, error } = await supabase.from('promotions')
      .update({ ended_at: now, ended_reason: String(reason || '').slice(0, 200) })
      .in('id', list.slice(i, i + 100)).is('ended_at', null).select('id');
    if (!error) n += (data || []).length;
  }
  return n;
}

// Varredura: o que este marketplace não mostra mais há STALE_HOURS horas vira "finalizada".
async function sweepStale(supabase, marketplaceId, hours = STALE_HOURS) {
  if (!(await endedSupported(supabase))) return 0;
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const now = new Date().toISOString();
  const reason = `Não aparece mais nas buscas há ${Math.round(hours / 24)} dias`;
  let total = 0;
  for (const filter of [`last_seen_at.lt.${cutoff}`, `and(last_seen_at.is.null,detected_at.lt.${cutoff})`]) {
    const { data, error } = await supabase.from('promotions')
      .update({ ended_at: now, ended_reason: reason })
      .eq('marketplace_id', marketplaceId).is('ended_at', null).neq('status', 'IGNORED').or(filter).select('id');
    if (!error) total += (data || []).length;
  }
  return total;
}

module.exports = { STALE_HOURS, endedSupported, reviveFields, markEnded, sweepStale };
