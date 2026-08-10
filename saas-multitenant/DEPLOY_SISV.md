# SISV — Deploy, Backup e Rollback

Stack já usada pelo projeto (não há stack nova): **backend em Docker** (+ nginx/certbot
opcionais) e **frontend em Vercel** (ou container). Banco **PostgreSQL isolado do SISV**.

> ⚠️ O SISV **nunca** compartilha banco, volume de uploads ou rede com o Nexos.
> A stack `deploy/sisv-docker-compose.yml` usa apenas recursos `sisv-*`.

---

## 1. Pré-requisitos
- Docker + Docker Compose na VPS (ou Postgres gerenciado + runtime Node 20).
- Domínio próprio (ex.: `app.<dominio>` para o frontend, `api.<dominio>` para a API).
- Acesso ao provedor de DNS e ao painel da Vercel (se o frontend for lá).
- `psql` disponível para migrations e backup.

## 2. Variáveis
| Variável | Onde | Obrigatória | Observação |
|---|---|---|---|
| `DATABASE_URL` | backend | ✅ | Banco **isolado** do SISV |
| `JWT_SECRET` | backend | ✅ | ≥32 caracteres, próprio do ambiente |
| `NODE_ENV` | backend | ✅ | `production` |
| `FRONTEND_URL` | backend | ✅ em prod | Origem do CORS, sem curinga |
| `EXTRA_CORS_ORIGINS` | backend | — | Lista extra separada por vírgula |
| `BASE_URL` | backend | recomendada | URL pública da API (links de arquivo) |
| `PORT` | backend | — | Padrão 5000 |
| `UPLOAD_MAX_MB` | backend | — | Padrão 10 (teto 50) |
| `BACKEND_URL` | frontend | ✅ | Destino do proxy `/api` e `/auth` |
| `NEXT_PUBLIC_APP_*` | frontend | — | Identidade SISV/TELUN |

Templates: `backend/.env.example`, `.env.example`, `deploy/sisv-backend.env.example`.
**A configuração é validada no startup** — em produção o backend não sobe com segredo
padrão, CORS aberto/curinga ou modo demo (`backend/config/env.js`).

## 3. Preparação do banco
```bash
# 1) Confirme QUAL banco você está apontando (nome, host, ambiente) ANTES de tudo
psql "$DATABASE_URL" -c "SELECT current_database(), inet_server_addr(), version();"

# 2) Confirme que é um banco do SISV (vazio ou já do SISV) — nunca o do Nexos
psql "$DATABASE_URL" -c "\dt" | head -20
```

## 4. Migrations (ordem obrigatória, idempotentes)
```bash
cd saas-multitenant/backend
# BACKUP ANTES (ver §8). Registre data/hora e a migration aplicada.
psql "$DATABASE_URL" -f migrations/000_nexos_schema.sql                        # schema base
psql "$DATABASE_URL" -f migrations/sisv_01_tenant_config.sql                   # config por tenant
psql "$DATABASE_URL" -f migrations/sisv_02_documents.sql                       # organização documental
psql "$DATABASE_URL" -f migrations/sisv_03_operations.sql                      # operação, pendências, alertas
psql "$DATABASE_URL" -f migrations/sisv_04_telun_identity.sql                  # identidade TELUN
psql "$DATABASE_URL" -f migrations/sisv_05_workflow_sla_automation.sql         # workflows e SLA
psql "$DATABASE_URL" -f migrations/sisv_06_commercial_backoffice_execution.sql # SISV 2.0 comercial
psql "$DATABASE_URL" -f migrations/sisv_07_user_access_control.sql             # acesso por usuario
psql "$DATABASE_URL" -f migrations/sisv_08_username_login.sql                  # login por username
psql "$DATABASE_URL" -f migrations/sisv_09_user_soft_delete.sql                # exclusao logica de usuario
psql "$DATABASE_URL" -f migrations/sisv_10_client_soft_delete.sql              # exclusao logica de cliente
psql "$DATABASE_URL" -f migrations/sisv_11_client_fields_partners_contractors.sql # clientes/parceiros/contratante
psql "$DATABASE_URL" -f migrations/sisv_12_client_registration_fields.sql          # cadastro ampliado de clientes
```

> A ordem importa: cada migration assume a anterior. Todas são idempotentes —
> reexecutar é seguro e não duplica objeto.

Verificação pós-migration (deve imprimir `t` e `23`):
```bash
# Estruturas das rodadas anteriores continuam de pé
psql "$DATABASE_URL" -Atc "SELECT to_regclass('public.document_categories') IS NOT NULL
  AND to_regclass('public.workflow_flows') IS NOT NULL"

# SISV 2.0: as 23 tabelas do domínio comercial
psql "$DATABASE_URL" -Atc "SELECT count(*) FROM information_schema.tables
 WHERE table_schema='public' AND table_name = ANY(ARRAY[
  'suppliers','catalog_items','price_tables','price_table_items',
  'orders','order_items','order_validations',
  'document_templates','generated_documents','commercial_contracts',
  'receivables','customer_payments','sales','sale_items',
  'service_orders','service_order_items','execution_costs',
  'payables','commissions','fiscal_documents','finalization_records',
  'commercial_counters','commercial_history'])"

# SISV 2.1: extensao de clientes, servicos e contratante (deve imprimir t)
psql "$DATABASE_URL" -Atc "SELECT
  to_regclass('public.client_field_definitions') IS NOT NULL
  AND to_regclass('public.service_client_field_requirements') IS NOT NULL
  AND EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='orders' AND column_name='contractor_type')
  AND EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='clients' AND column_name='additional_data')"

# SISV 2.2: cadastro ampliado e acessos do cliente (deve imprimir t)
psql "$DATABASE_URL" -Atc "SELECT
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_name='clients' AND column_name='client_code')
  AND EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='clients' AND column_name='portal_access')
  AND EXISTS (SELECT 1 FROM client_field_definitions WHERE field_key='client_type')"
```

Antes de apontar para produção, a cadeia inteira pode ser ensaiada num cluster
PostgreSQL descartável, sem tocar em banco algum do ambiente:
```bash
npm run test:postgres   # aplica 000→12, prova idempotência, rollback e reaplicação
```

## 5. Build
```bash
cd saas-multitenant/backend && npm ci --omit=dev && npm test   # testes antes de publicar
cd .. && npm ci && npm run build
```

## 6. Publicar o backend
```bash
cp deploy/sisv-backend.env.example deploy/sisv-backend.env   # preencher
chmod 600 deploy/sisv-backend.env
docker compose -f deploy/sisv-docker-compose.yml up -d postgres backend
docker compose -f deploy/sisv-docker-compose.yml logs -f backend | head -30
curl -fsS http://127.0.0.1:8097/health   # liveness
curl -fsS http://127.0.0.1:8097/ready    # banco + armazenamento
```

## 7. Publicar o frontend
- **Vercel:** projeto apontando para `saas-multitenant/`; definir `BACKEND_URL` e as
  `NEXT_PUBLIC_*`; domínio `app.<dominio>`.
- **Container:** `docker compose -f deploy/sisv-docker-compose.yml up -d frontend`.

## 8. Domínio, SSL e CORS
- DNS: `api.<dominio>` → VPS; `app.<dominio>` → Vercel/VPS.
- SSL: certbot via profile `proxy`, terminação no provedor, ou **Cloudflare Tunnel**
  (recomendado nesta VPS, onde 80/443 já estão ocupados por outras stacks — ver §8.1).
- CORS: `FRONTEND_URL=https://app.<dominio>` (sem curinga). Origem divergente = bloqueio.

## 8.1 Publicação via Cloudflare Tunnel (sem abrir porta na VPS)

A VPS já hospeda outras stacks nas portas 80/443. O SISV publica a API por um
túnel nomeado, que sai da VPS para a Cloudflare — nenhuma porta nova é exposta.

**No painel Cloudflare** (Zero Trust → Networks → Tunnels), o túnel `api-sisv`
precisa da rota:

| Public hostname | Service |
| --- | --- |
| `api-sisv.chronostek.com.br` | `http://sisv-backend:5000` |

O *service* usa o **nome do container**, não `127.0.0.1` — dentro do container do
cloudflared, `localhost` é ele mesmo. Backend e túnel compartilham a rede
`sisv-network`, então o nome resolve.

```bash
# Token do túnel: nunca no compose, nunca em chat/ticket.
cp deploy/sisv-tunnel.env.example deploy/sisv-tunnel.env
$EDITOR deploy/sisv-tunnel.env          # cole o TUNNEL_TOKEN real
chmod 600 deploy/sisv-tunnel.env

docker compose -f deploy/sisv-docker-compose.yml up -d tunnel
docker compose -f deploy/sisv-docker-compose.yml logs --tail=30 tunnel
```

No log, `Registered tunnel connection` confirma a conexão. Se o token já circulou
em texto puro (chat, e-mail, print), **revogue e gere outro** antes de publicar:
Zero Trust → Networks → Tunnels → o túnel → *Refresh token*.

Verificação externa:
```bash
curl -fsS https://api-sisv.chronostek.com.br/health   # {"status":"ok",...}
curl -fsS https://api-sisv.chronostek.com.br/ready    # {"status":"ready",...}
```

## 9. Tenant inicial e primeiro administrador
```bash
# Tenant SISV + catálogos (idempotente; NÃO cria clientes/processos fictícios)
DATABASE_URL=... node scripts/seed_sisv.js

# Primeiro administrador — senha via variável de ambiente, NUNCA no código,
# e o script não imprime a senha.
SISV_NEW_ADMIN_PASSWORD='<senha-forte-escolhida>' DATABASE_URL=... \
  node scripts/create_admin.js --tenant sisv --email pessoa@empresa.com --name "Nome Completo"
unset SISV_NEW_ADMIN_PASSWORD
```
> Em produção **não** use os usuários de exemplo do seed. Crie o administrador real
> pelo `create_admin.js` e remova/desative os usuários de exemplo.

## 10. Smoke tests pós-deploy
Use `HOMOLOGACAO.md` (roteiro de 31 itens). Mínimo: login, criar cliente, criar processo,
anexar documento, baixar documento, histórico, dashboard, `/health` e `/ready`.

---

# Backup

```bash
# Dump lógico completo (rode ANTES de qualquer migration/deploy)
STAMP=$(date +%Y%m%d-%H%M%S)
pg_dump "$DATABASE_URL" -Fc -f "backup-sisv-$STAMP.dump"

# Uploads (volume Docker)
docker run --rm -v sisv-backend-uploads:/data -v "$PWD:/out" alpine \
  tar czf "/out/uploads-sisv-$STAMP.tar.gz" -C /data .
```
Guarde os dois artefatos juntos (banco + arquivos) e anote data/hora e a versão publicada.
`backups/`, `*.dump` e `*.tar.gz` já estão no `.gitignore`.

# Rollback

O rollback tem **três camadas** — reverter só o commit não basta.

**1) Banco**
```bash
# Opção A — desfazer as extensões recentes (ordem inversa, depois de voltar as aplicações)
psql "$DATABASE_URL" -f migrations/sisv_12_client_registration_fields_rollback.sql
psql "$DATABASE_URL" -f migrations/sisv_11_client_fields_partners_contractors_rollback.sql

# Para rodadas antigas, sempre use a ordem inversa e valide dependências.
psql "$DATABASE_URL" -f migrations/sisv_02_documents_rollback.sql
psql "$DATABASE_URL" -f migrations/sisv_01_tenant_config_rollback.sql

# Opção B — restaurar o dump (DESTRUTIVO: só com confirmação explícita)
pg_restore -d "$DATABASE_URL" --clean --if-exists backup-sisv-<STAMP>.dump
```

**2) Aplicações**
```bash
# Backend: voltar para o commit/tag anterior e reconstruir
git checkout <tag-anterior>
docker compose -f deploy/sisv-docker-compose.yml up -d --build backend
# Frontend (Vercel): "Promote to Production" no deployment anterior (rollback instantâneo)
```

**3) Uploads**
```bash
docker run --rm -v sisv-backend-uploads:/data -v "$PWD:/in" alpine \
  sh -c "cd /data && tar xzf /in/uploads-sisv-<STAMP>.tar.gz"
```

**Validação pós-rollback:** `/health` e `/ready` em 200; login; abrir um processo;
baixar um documento; conferir histórico; console do navegador sem erro.

---

## Ambientes
| | Desenvolvimento | Homologação | Produção |
|---|---|---|---|
| Banco | local/pg-mem | **próprio** | **próprio e isolado** |
| Dados | fictícios | controlados/fictícios | reais |
| Migrations | livres | **as mesmas da produção** | as mesmas |
| CORS | localhost | domínio de homologação | domínio real, sem curinga |
| Modo demo | opcional | desligado | **bloqueado no startup** |
| Seed automático | opcional | manual | **bloqueado no startup** |
| Backup | — | recomendado | **obrigatório + rollback testado** |

---

# Runbook — subir o SISV 2.0 em produção (VPS + Vercel)

Sequência executável para o ambiente `api-sisv.chronostek.com.br`. Cada passo tem
uma verificação; **não avance com verificação falhando**.

A ordem existe por dois motivos: o backend recusa subir sem CORS configurado
(§2), e o CORS precisa do domínio do frontend. Por isso o frontend é publicado
antes de o backend receber a origem definitiva.

## Passo 0 — Ensaio local (não toca em produção)

```bash
cd saas-multitenant
( cd backend && npm ci && npm test && npm run test:postgres )
npm ci && npm run lint && npm run build
```

`test:postgres` sobe um PostgreSQL descartável em `backend/.postgres-test`,
aplica `000→12`, prova idempotência, rollback e reaplicação. É o ensaio da
migration que vai rodar em produção.

## Passo 1 — Segredos da VPS

```bash
ssh root@167.233.26.140
cd /opt/sisv          # ajuste para o caminho do checkout na VPS

cp deploy/sisv-backend.env.example deploy/sisv-backend.env
cp deploy/sisv-tunnel.env.example  deploy/sisv-tunnel.env
chmod 600 deploy/sisv-backend.env deploy/sisv-tunnel.env
```

Gere o segredo do JWT **na VPS** (não reaproveite nada que já tenha circulado):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Preencha `deploy/sisv-backend.env`:

| Variável | Valor |
| --- | --- |
| `DATABASE_URL` | `postgres://sisv:<SENHA>@postgres:5432/sisv?sslmode=disable` |
| `POSTGRES_USER` / `POSTGRES_DB` | `sisv` |
| `POSTGRES_PASSWORD` | senha forte gerada agora |
| `JWT_SECRET` | o hex de 96 caracteres gerado acima |
| `NODE_ENV` | `production` |
| `BASE_URL` | `https://api-sisv.chronostek.com.br` |
| `FRONTEND_URL` | **deixe vazio por enquanto** — preenchido no Passo 4 |

E `deploy/sisv-tunnel.env` com o `TUNNEL_TOKEN` do túnel `api-sisv`.

> O backend **não sobe** em produção sem `FRONTEND_URL` (ou `EXTRA_CORS_ORIGINS`).
> Isso é proposital: CORS aberto em produção é falha de segurança, não conveniência.
> Até o Passo 4, use um valor provisório se precisar validar o backend antes.

## Passo 2 — Banco e migrations

```bash
docker compose -f deploy/sisv-docker-compose.yml up -d postgres
docker compose -f deploy/sisv-docker-compose.yml exec postgres \
  pg_isready -U sisv -d sisv

# Banco novo? Não há o que fazer backup. Banco existente: dump ANTES (§8).
docker compose -f deploy/sisv-docker-compose.yml exec -T postgres \
  pg_dump -U sisv -d sisv > /root/backup-sisv-$(date +%F-%H%M).sql
```

Aplique as migrations dentro do container (o Postgres não publica porta no host):

```bash
for m in 000_nexos_schema sisv_01_tenant_config sisv_02_documents \
         sisv_03_operations sisv_04_telun_identity \
         sisv_05_workflow_sla_automation sisv_06_commercial_backoffice_execution \
         sisv_07_user_access_control sisv_08_username_login \
         sisv_09_user_soft_delete sisv_10_client_soft_delete \
         sisv_11_client_fields_partners_contractors \
         sisv_12_client_registration_fields; do
  echo "→ $m"
  docker compose -f deploy/sisv-docker-compose.yml exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U sisv -d sisv < backend/migrations/$m.sql || break
done
```

Verificação (esperado: `23`):

```bash
docker compose -f deploy/sisv-docker-compose.yml exec -T postgres \
  psql -Atc "SELECT count(*) FROM information_schema.tables
   WHERE table_schema='public' AND table_name = ANY(ARRAY[
    'suppliers','catalog_items','price_tables','price_table_items',
    'orders','order_items','order_validations',
    'document_templates','generated_documents','commercial_contracts',
    'receivables','customer_payments','sales','sale_items',
    'service_orders','service_order_items','execution_costs',
    'payables','commissions','fiscal_documents','finalization_records',
    'commercial_counters','commercial_history'])" -U sisv -d sisv
```

## Passo 3 — Backend e túnel

```bash
docker compose -f deploy/sisv-docker-compose.yml up -d --build backend
docker compose -f deploy/sisv-docker-compose.yml logs --tail=40 backend

curl -fsS http://127.0.0.1:8097/health   # {"status":"ok",...}
curl -fsS http://127.0.0.1:8097/ready    # {"status":"ready","checks":{...}}

docker compose -f deploy/sisv-docker-compose.yml up -d tunnel
curl -fsS https://api-sisv.chronostek.com.br/health
```

Se `/ready` responder `503`, o corpo diz **qual** dependência caiu (`database` ou
`storage`); o detalhe do erro fica no log do container, não na resposta.

## Passo 4 — Frontend na Vercel

O projeto aponta para `saas-multitenant/`. Variável de ambiente (Production):

| Variável | Valor |
| --- | --- |
| `BACKEND_URL` | `https://api-sisv.chronostek.com.br` |

`BACKEND_URL` faz duas coisas: alimenta os *rewrites* (`/api/*` e `/auth/*` saem
do domínio da Vercel e chegam ao backend) e monta o `connect-src` do CSP. O
navegador só fala com a origem da Vercel — por isso não há CORS no caminho feliz.

```bash
cd saas-multitenant
npx vercel login                 # autentique na sua conta
npx vercel link                  # vincule ao projeto SISV
npx vercel --prod                # publica
```

> Não passe `--token` na linha de comando: o token fica no histórico do shell.
> `vercel login` grava a credencial no perfil do usuário.

Anote o domínio publicado (ex.: `sisv.vercel.app` ou o domínio próprio).

## Passo 5 — Fechar o CORS

Com o domínio do frontend em mãos, volte à VPS:

```bash
$EDITOR deploy/sisv-backend.env
# FRONTEND_URL=https://<dominio-publicado>
docker compose -f deploy/sisv-docker-compose.yml up -d backend
```

Verificação — a origem correta passa, a errada é bloqueada:

```bash
curl -si https://api-sisv.chronostek.com.br/health \
  -H "Origin: https://<dominio-publicado>" | grep -i access-control-allow-origin
curl -si https://api-sisv.chronostek.com.br/health \
  -H "Origin: https://origem-nao-autorizada.exemplo" | grep -i access-control-allow-origin
```

## Passo 6 — Tenant e primeiro administrador

```bash
docker compose -f deploy/sisv-docker-compose.yml exec backend \
  node scripts/seed_sisv.js          # tenant SISV + catálogos CNH (idempotente)
```

O seed cria usuários de exemplo. **Em produção**, crie o administrador real e
desative os de exemplo:

```bash
docker compose -f deploy/sisv-docker-compose.yml exec \
  -e SISV_NEW_ADMIN_PASSWORD='<senha-forte>' backend \
  node scripts/create_admin.js --tenant sisv \
    --email pessoa@chronostek.com.br --name "Nome Completo"
```

O script não imprime a senha e recusa senha fraca. Force a troca no primeiro
acesso e remova/desative os usuários de exemplo do seed antes de liberar o time.

## Passo 7 — Verificação pós-deploy

Roteiro completo em `HOMOLOGACAO.md`. Mínimo para considerar o deploy bom:

1. Login com o administrador real; identidade TELUN na tela.
2. Criar cliente → criar pedido → adicionar item (preço vem da tabela).
3. Enviar para validação → devolver com justificativa → reenviar → aprovar.
4. Informar pagamento → conferir que o recebível **não** mudou → aprovar → conferir que mudou.
5. Confirmar venda pela prévia → gerar ordem de serviço → liberar → iniciar.
6. Registrar custo → “Preparar pagamentos” → confirmar obrigações.
7. Concluir → registrar nota fiscal (manual) → finalizar → arquivar.
8. Dashboard executivo com números reais; um indicador abre a fila.
9. `/health` e `/ready` respondendo 200.
10. Configurar campo obrigatório em um serviço; pedido bloqueia sem o dado e libera após preenchimento.
11. Criar parceiro contratante; pedido mostra cliente atendido, parceiro e snapshot das condições.
12. Alterar/inativar o parceiro; pedido anterior preserva as condições e o seletor aceita apenas ativos.

## Rollback

| Situação | Ação |
| --- | --- |
| Frontend quebrado | Vercel → deployment anterior → *Promote to Production* (instantâneo) |
| Backend quebrado | `git checkout <tag-anterior>` e `up -d --build backend` |
| Migration 12 problemática | voltar backend/frontend e executar `psql ... -f migrations/sisv_12_client_registration_fields_rollback.sql` |
| Migration 11 problemática | voltar backend/frontend e executar `psql ... -f migrations/sisv_11_client_fields_partners_contractors_rollback.sql` |
| Migration 06 problemática | `psql ... -f migrations/sisv_06_commercial_backoffice_execution_rollback.sql` |
| Banco corrompido | restaurar o dump do Passo 2 (**destrutivo** — confirme antes) |

O rollback da 06 apaga os dados comerciais (pedidos, vendas, ordens,
recebimentos, obrigações, comissões, documentos, notas e finalizações) e
preserva o que veio antes — clientes, processos e workflows. Isso é verificado
por `npm run test:postgres`.

O rollback da 11 deve ocorrer **antes** do rollback da 06, pois suas tabelas e
chaves referenciam catálogo, fornecedores e pedidos. Ele remove os campos e
snapshots novos, mas preserva as entidades comerciais anteriores. Consulte
`SISV_21_CLIENTES_PARCEIROS.md` para o impacto detalhado.
