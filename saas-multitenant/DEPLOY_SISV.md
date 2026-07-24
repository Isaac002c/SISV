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
psql "$DATABASE_URL" -f migrations/000_nexos_schema.sql        # schema base
psql "$DATABASE_URL" -f migrations/sisv_01_tenant_config.sql   # config por tenant
psql "$DATABASE_URL" -f migrations/sisv_02_documents.sql       # organização documental

# Verificação pós-migration
psql "$DATABASE_URL" -c "\d document_categories" >/dev/null && echo "sisv_02 OK"
psql "$DATABASE_URL" -c "SELECT column_name FROM information_schema.columns
  WHERE table_name='fines' AND column_name IN ('department_id','last_moved_at','finalized_at');"
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
- SSL: certbot via profile `proxy`, ou terminação no provedor.
- CORS: `FRONTEND_URL=https://app.<dominio>` (sem curinga). Origem divergente = bloqueio.

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
Use `HOMOLOGACAO.md` (roteiro de 21 itens). Mínimo: login, criar cliente, criar processo,
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
# Opção A — desfazer apenas as migrations do SISV (preserva o restante)
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
