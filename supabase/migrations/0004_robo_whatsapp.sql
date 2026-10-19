-- ============================================================
-- 0004 — Robô do WhatsApp (disparo 100% automático)
-- Rode UMA vez: Supabase > SQL Editor > New query > cole tudo > Run.
-- É seguro rodar de novo (não estraga nada).
-- ============================================================

-- 1) Última vez que o robô consultou o servidor (a tela mostra "Robô conectado").
alter table dispatch_destinations add column if not exists bot_seen_at timestamptz;

-- 2) Se a tabela de disparos tiver uma trava que só aceita os modos antigos ('auto', 'assisted'),
--    remove essa trava para aceitar o novo modo 'bot'. (Se não houver trava, não faz nada.)
do $$
declare r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    where c.contype = 'c'
      and c.conrelid = 'dispatch_jobs'::regclass
      and pg_get_constraintdef(c.oid) ilike '%mode%'
  loop
    execute format('alter table dispatch_jobs drop constraint %I', r.conname);
  end loop;
end $$;
