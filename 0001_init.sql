-- ============================================================
-- Radar de Promoções — schema inicial (Fase 1: Mercado Livre)
-- ============================================================

-- Marketplaces (cadastro fixo, com logo para o painel Matriz)
create table if not exists marketplaces (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,          -- 'mercadolivre', 'shopee', ...
  name text not null,                 -- 'Mercado Livre'
  logo_url text,                      -- usado no painel Matriz para identificar a origem
  affiliation_mode text not null default 'manual', -- 'manual' | 'api' | 'conditional_api'
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into marketplaces (slug, name, affiliation_mode)
values ('mercadolivre', 'Mercado Livre', 'manual')
on conflict (slug) do nothing;

-- ============================================================
-- CREDENCIAIS — isolado, nunca junto de dados de performance.
-- Só o service_role do backend acessa esta tabela (RLS abaixo).
-- ============================================================
create table if not exists marketplace_credentials (
  id uuid primary key default gen_random_uuid(),
  marketplace_id uuid not null references marketplaces(id) on delete cascade,
  client_id text,
  client_secret text,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  seller_id text,              -- id do vendedor autenticado no ML
  updated_at timestamptz not null default now(),
  unique (marketplace_id)
);

alter table marketplace_credentials enable row level security;
-- Nenhuma policy de leitura é criada de propósito: só service_role (que ignora RLS) acessa.

-- ============================================================
-- MÉTRICAS DA SUA LOJA (webhook) — separado das credenciais.
-- Alimentado pelos tópicos: orders_v2, items, public_offers, public_candidates.
-- ============================================================
create table if not exists ml_seller_metrics (
  id uuid primary key default gen_random_uuid(),
  item_id text not null,             -- MLBxxxxxxxxx
  title text,
  status text,                       -- active, paused, closed...
  price numeric,
  available_quantity integer,
  sold_quantity integer,
  visits bigint,                     -- preenchido quando disponível via API de visitas
  promotion_status text,             -- status vindo de public_offers / public_candidates
  promotion_type text,               -- DEAL, MARKETPLACE_CAMPAIGN, LIGHTNING, etc.
  raw_payload jsonb,                 -- payload bruto do último evento, para auditoria/debug
  updated_at timestamptz not null default now(),
  unique (item_id)
);

create index if not exists idx_ml_seller_metrics_item on ml_seller_metrics (item_id);

-- ============================================================
-- Eventos brutos de webhook (auditoria, reprocessamento, debug)
-- ============================================================
create table if not exists webhook_events (
  id uuid primary key default gen_random_uuid(),
  marketplace_id uuid references marketplaces(id),
  topic text not null,
  resource text,
  raw_payload jsonb not null,
  processed boolean not null default false,
  processed_at timestamptz,
  error text,
  received_at timestamptz not null default now()
);

create index if not exists idx_webhook_events_processed on webhook_events (processed, received_at);

-- ============================================================
-- Categorias vigiadas — a varredura de "outros vendedores" roda
-- em cima destas categorias (busca pública, sem autenticação).
-- ============================================================
create table if not exists watched_categories (
  id uuid primary key default gen_random_uuid(),
  marketplace_id uuid not null references marketplaces(id) on delete cascade,
  category_id text not null,     -- ex: MLB1051 (Celulares e Telefones)
  category_name text,
  min_discount_pct numeric default 15,  -- só considera queda de preço acima disso
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (marketplace_id, category_id)
);

-- ============================================================
-- Produtos monitorados via varredura pública (não são da sua loja)
-- ============================================================
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  marketplace_id uuid not null references marketplaces(id) on delete cascade,
  source_item_id text not null,      -- id do item no marketplace de origem
  title text,
  image_url text,
  permalink text,                    -- URL original do produto
  seller_nickname text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (marketplace_id, source_item_id)
);

create table if not exists product_price_history (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  price numeric not null,
  checked_at timestamptz not null default now()
);

create index if not exists idx_price_history_product on product_price_history (product_id, checked_at desc);

-- ============================================================
-- PROMOÇÕES — o que alimenta o painel Matriz.
-- Guarda o link original + a data em que foi disponibilizada,
-- para você localizar e gerar o link de afiliado manualmente.
-- ============================================================
create table if not exists promotions (
  id uuid primary key default gen_random_uuid(),
  marketplace_id uuid not null references marketplaces(id),
  product_id uuid references products(id),   -- null quando a promoção vem da sua própria loja
  ml_seller_metric_id uuid references ml_seller_metrics(id), -- preenchido quando a origem é sua loja
  title text not null,
  image_url text,
  original_url text not null,
  current_price numeric,
  previous_price numeric,
  discount_rate numeric,
  source text not null default 'category_scan', -- 'category_scan' | 'own_store_webhook'
  status text not null default 'PENDING',       -- PENDING | AFFILIATED | IGNORED
  affiliate_url text,               -- opcional: você pode colar aqui depois de gerar manualmente
  affiliate_url_added_at timestamptz,
  detected_at timestamptz not null default now()
);

create index if not exists idx_promotions_marketplace on promotions (marketplace_id, detected_at desc);
create index if not exists idx_promotions_status on promotions (status);

alter table promotions enable row level security;
-- Leitura pública do painel Matriz (não há dado sensível aqui: só título, imagem, link, preço).
create policy "Leitura pública das promoções" on promotions
  for select using (true);

-- ATENÇÃO: esta policy libera UPDATE anônimo (usada pelos botões "Já afiliei" / "Ignorar"
-- do painel, que hoje não tem tela de login). Isso é aceitável só enquanto o painel não
-- for exposto publicamente (URL "obscura", uso pessoal). Antes de compartilhar o link
-- com terceiros, troque isto por Supabase Auth e restrinja por usuário autenticado.
create policy "Atualização de status pelo painel (sem auth ainda)" on promotions
  for update using (true) with check (true);
-- INSERT continua só pelo backend (service_role) — nenhuma policy de insert para anon.

-- ============================================================
-- Logs de integração (debug/observabilidade)
-- ============================================================
create table if not exists integration_logs (
  id uuid primary key default gen_random_uuid(),
  marketplace_id uuid references marketplaces(id),
  level text not null default 'info', -- info | warn | error
  message text not null,
  context jsonb,
  created_at timestamptz not null default now()
);
