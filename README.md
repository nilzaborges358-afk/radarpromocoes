# Radar de Promoções — Fase 1 (Mercado Livre)

O que este projeto já faz:

1. **Trilha 1 — sua loja (webhook completo):** você autoriza sua conta de vendedor no ML,
   e o sistema recebe eventos reais (itens, status de promoção) e grava em `ml_seller_metrics`
   — separado das credenciais.
2. **Trilha 2 — promoções de outros vendedores (varredura pública):** a cada 30 minutos
   (`vercel.json`), o sistema varre sozinho as categorias cadastradas em `watched_categories`
   usando a busca pública do ML (sem login), compara o preço com a última verificação e,
   se caiu acima do `min_discount_pct`, grava uma linha em `promotions`.
3. **Painel Matriz** (`/public/index.html`): mostra todas as promoções encontradas, com
   selo do marketplace, preço antes/depois, link original e a data em que foi detectada —
   pra você clicar, ir até o Mercado Livre e gerar o link de afiliado manualmente.

---

## Passo 1 — Supabase

1. Crie um projeto em [supabase.com](https://supabase.com).
2. Vá em **SQL Editor** e rode o conteúdo de `supabase/migrations/0001_init.sql`.
3. Em **Settings → API**, copie:
   - `Project URL` → vai virar `SUPABASE_URL`
   - `anon public` key → vai virar `SUPABASE_ANON_KEY` (usada só no painel, `public/config.js`)
   - `service_role` key → vai virar `SUPABASE_SERVICE_ROLE_KEY` (**nunca** no frontend)
4. Cadastre pelo menos uma categoria pra vigiar (troque o `category_id` pelo que quiser —
   os códigos de categoria do ML aparecem na URL quando você navega por uma categoria no site):

   ```sql
   insert into watched_categories (marketplace_id, category_id, category_name, min_discount_pct)
   select id, 'MLB1051', 'Celulares e Telefones', 15 from marketplaces where slug = 'mercadolivre';
   ```

## Passo 2 — GitHub

1. Crie um repositório novo (privado) no GitHub.
2. Dentro desta pasta: `git init`, `git add .`, `git commit -m "setup inicial"`.
3. `git remote add origin <URL do seu repo>` e `git push -u origin main`.

## Passo 3 — App no Mercado Livre

1. Acesse [developers.mercadolivre.com.br](https://developers.mercadolivre.com.br) → **Minhas aplicações → Criar aplicação**.
2. Anote o **Client ID** e o **Client Secret**.
3. Em **Notificações**, marque os tópicos: `items`, `public_offers`, `public_candidates`
   (depois pode adicionar `orders_v2`, `questions`, `shipments`).
4. A **Callback URL de notificações** vai ser: `https://SEU-PROJETO.vercel.app/api/webhooks/mercadolivre`
   (só dá pra preencher isso depois do Passo 4, quando você já tiver a URL da Vercel).

## Passo 4 — Vercel

1. Importe o repositório do GitHub em [vercel.com](https://vercel.com) → **Add New Project**.
2. Em **Environment Variables**, adicione todas as variáveis de `.env.example` com os
   valores reais (Client ID/Secret do ML, dados do Supabase). A `MERCADOLIVRE_REDIRECT_URI`
   fica `https://SEU-PROJETO.vercel.app/api/auth/mercadolivre/callback`.
3. Faça o deploy.
4. Volte no app do Mercado Livre (Passo 3) e cole a Callback URL de notificações.

## Passo 5 — Conectar sua conta de vendedor

1. Edite `public/config.js` com a `SUPABASE_URL` e a `SUPABASE_ANON_KEY` reais, e suba de novo
   (`git add . && git commit -m "config" && git push`).
2. Acesse `https://SEU-PROJETO.vercel.app/api/auth/mercadolivre/login`, faça login com a
   conta de vendedor no Mercado Livre e autorize o app.
3. Pronto — a partir daí, toda mudança nos seus itens/promoções chega via webhook.

## Passo 6 — Ver o painel

Acesse `https://SEU-PROJETO.vercel.app/index.html` (ou configure a Vercel pra servir
`public/index.html` na raiz). As promoções aparecem conforme o cron roda (a cada 30 min)
e conforme os webhooks chegam.

---

## Avisos importantes

- **Sem tela de login ainda.** O painel e a atualização de status ("Já afiliei"/"Ignorar")
  hoje são de acesso livre pra quem tiver o link — está anotado no comentário da migration
  (`0001_init.sql`). Antes de compartilhar a URL com qualquer outra pessoa, isso precisa
  virar Supabase Auth.
- **`orders_v2`, `questions`, `shipments`**: os tópicos estão previstos no webhook mas o
  processamento deles ainda não foi implementado (só `items`, `public_offers`,
  `public_candidates`) — é o próximo passo natural depois de validar esse primeiro fluxo.
- **Só Mercado Livre por enquanto.** Shopee, Amazon, Magalu, TikTok Shop e Netshoes ficam
  para as próximas fases, seguindo a mesma pasta `/src/integrations/<marketplace>`.
