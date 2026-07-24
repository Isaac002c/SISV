# SISV — Sistema Integrado da Sinal Verde (TELUN)

Adaptação da base **NexoCRM** (SaaS multi-tenant) para a operação de processos de
**CNH** da **Sinal Verde**. Reaproveita frontend, backend, banco, autenticação,
modelo multi-tenant, clientes, processos, documentos e histórico já existentes —
**sem criar arquitetura paralela** e **sem remover funcionalidades dos demais
tenants**.

> A entidade `fines` do Nexos é o **“processo”** do sistema. O SISV opera sobre
> ela com semântica de CNH: etapas/status/tipos de serviço/setores **configuráveis
> por tenant**, responsável atual, movimentação, redistribuição, finalização,
> reabertura, observações, documentos e histórico automático.

## O que foi adicionado (não destrutivo)

- **Config por tenant**: `tenants.modules` (módulos habilitados) e `tenants.developer`.
- **Catálogos isolados por tenant**: `departments` (setores), `process_stages`
  (etapas), `process_statuses` (status), `tenant_service_types` (tipos de serviço).
- **Colunas de operação em `fines`**: `department_id`, `tenant_service_type_id`,
  `finalized_at`, `reopened_at`, `last_moved_at`.
- **Gating de módulos** por tenant (UI + rota + API). `modules = NULL` = todos
  habilitados (tenants legados seguem idênticos).

## Migrations (ordem)

```bash
psql "$DATABASE_URL" -f migrations/000_nexos_schema.sql          # base (se ainda não aplicada)
psql "$DATABASE_URL" -f migrations/sisv_01_tenant_config.sql     # config por tenant (idempotente)
psql "$DATABASE_URL" -f migrations/sisv_02_documents.sql         # organização documental (idempotente)
```

Rollback do SISV (apaga apenas o que a migration criou):

```bash
psql "$DATABASE_URL" -f migrations/sisv_01_tenant_config_rollback.sql
```

## Provisionar o tenant Sinal Verde

Cria/atualiza o tenant `SISV` (identidade TELUN, branding, módulos), 4 usuários
(1 gestor + 3 operacionais) e os catálogos CNH iniciais. **Idempotente.**

```bash
cd saas-multitenant/backend
DATABASE_URL=... node scripts/seed_sisv.js
```

Senhas: definidas por env `SISV_ADMIN_PASSWORD`, `SISV_OPERADOR1_PASSWORD`, … ou
geradas aleatoriamente e **impressas uma única vez** no fim do seed (troque no
primeiro acesso). Nenhuma senha fica salva em arquivo.

## Módulos habilitados no tenant SISV

`dashboard`, `clientes`, `processos`, `documentos`, `historico`, `usuarios`,
`config`. Fora daqui (financeiro, leads, empresas, agenda, aprovações, comercial)
fica **bloqueado no menu, na rota e na API**.

## Identidade (configurável por variáveis de ambiente — sem logo fabricada)

Frontend (`.env` do Next / Vercel):

```
NEXT_PUBLIC_APP_NAME=SISV
NEXT_PUBLIC_APP_TAGLINE=Sistema Integrado da Sinal Verde
NEXT_PUBLIC_APP_DEVELOPER=TELUN
NEXT_PUBLIC_BRAND_COLOR=#15803d
NEXT_PUBLIC_BRAND_COLOR_DARK=#052e16
NEXT_PUBLIC_SUPPORT_EMAIL=suporte@telun.com.br
```

A identidade específica do tenant (nome/cor/logo) também vive no registro do
tenant e pode ser editada por `PUT /api/tenant` (admin) ou no seed.

## Rodar localmente

```bash
# Backend real (porta 5000) — requer DATABASE_URL e JWT_SECRET no backend/.env
cd saas-multitenant/backend && npm install && node app.js

# Frontend (porta 3001)
cd saas-multitenant && npm install && npm run dev
```

## Smoke test sem banco (pg-mem)

Sobe o backend **real** (rotas de tenant/config/processos/clientes) sobre um
Postgres em memória já semeado com o tenant SISV + processos de exemplo:

```bash
cd saas-multitenant/backend && node sisv-demo-server.js   # porta 5000
# login demo: gestor@sinalverde.com.br (admin) | operador1@sinalverde.com.br (operator)
```

## Testes

```bash
cd saas-multitenant/backend && npm test     # node --test (inclui SISV: isolamento, fluxo, histórico, gating)
cd saas-multitenant && npm run build        # build de produção Next.js
cd saas-multitenant && npx next lint        # lint
```

## Recursos da fila de processos

- Filtros combináveis: `stage`, `status`, `seller_id` (ou `none`), `department_id`
  (ou `none`), `tenant_service_type_id`, `client_id`, `q` (busca por cliente/CPF/
  número/protocolo/placa), `pending`, `finalized`, `stale_days`, **`overdue`**
  (prazo vencido), **`due_soon`** (vence em 7 dias), `due_from`/`due_to`,
  `date_from`/`date_to`.
- Paginação (`limit`/`offset`) e ordenação por coluna (`sort_by`/`sort_dir`:
  cliente, etapa, status, prazo, última movimentação).
- **Prazos**: coluna com cor de urgência (vencido/hoje/≤7 dias), KPIs no dashboard
  (vencidos, vence em 7 dias) e atalhos clicáveis para a fila filtrada.
- **Exportação CSV** da visão filtrada (até 200 processos).
- Edição dos dados do processo (número, protocolo, tipo de serviço, data de
  abertura, prazo) na aba Visão geral do detalhe.

## API principal do SISV

- `GET/PUT /api/tenant`, `GET /api/tenant/me`, `GET /api/tenant/users`
- `GET /api/config` e CRUD em `/api/config/{stages,statuses,service-types,departments}` (escrita: admin)
- `GET /api/processes` (fila com filtros combináveis + paginação + ordenação), `GET /api/processes/dashboard`
- `POST /api/processes/batch/assign` — distribuição em lote (responsável e/ou setor)
- `POST /api/processes`, `PUT /api/processes/:id`
- `PATCH /api/processes/:id/{stage,status,seller,department}`
- `POST /api/processes/:id/{notes,finalize,reopen}` (reopen: admin)
- `GET/POST/DELETE /api/processes/:id/documents`, `GET /api/processes/:id/logs`

## Módulo documental (SISV)

- **Categorias por tenant** (`document_categories`): CRUD em `/api/config/document-categories`
  (escrita admin); usadas em documentos do cliente e do processo.
- **Metadados + soft-delete** em `documents` e `fine_documents`: `category_id`, `original_name`,
  `stored_name`, `notes`/`description`, `status` (ativo/arquivado/removido), `archived_at`,
  `removed_by`, `removed_at`. Remoção é **lógica** (preserva histórico).
- **Segurança de arquivos**: upload valida extensão (allowlist PDF/JPG/PNG/WEBP), MIME e
  **assinatura (magic bytes)** — não confia no Content-Type; nomes físicos são UUID; download
  é **controlado pelo backend** (`GET …/download`) com validação de tenant e proteção contra
  path traversal (`services/fileStorage.js`, `services/fileValidation.js`). Sem URL pública previsível.
- **Checklist por tipo de serviço** (`service_type_documents`): `GET/PUT
  /api/config/service-types/:id/checklist` (transacional). Exibido no processo como recebido/pendente
  (orienta a equipe, não bloqueia).
- **Endpoints** — cliente: `GET /api/documents/:id/download`, `POST /api/documents/:id/{archive,restore,remove}`.
  Processo: `POST /api/processes/:id/documents`, `GET …/:docId/download`, `PATCH …/:docId`,
  `POST …/:docId/{archive,restore}`, `DELETE …/:docId` (soft).

## Componentes de tela do SISV (frontend)

- `app/multas/DashboardSISV.jsx` — painel operacional.
- `app/multas/Processos.jsx` — fila + detalhe (abas) + criação/edição.
- `app/multas/ProcessosConfig.jsx` — catálogos (etapas, status, serviços, setores).
- `app/multas/ClienteDetalhe.jsx` — detalhe do cliente (dados, processos, documentos).
- `app/multas/HistoricoSISV.jsx` — histórico consolidado das movimentações.
- `app/multas/DocumentsManager.jsx` — gestão de documentos reutilizável (cliente e processo).
- `app/lib/{brand,processesAPI,tenantConfigAPI,documentsAPI}.js` — identidade e clients de API.

## Rollback das migrations
```bash
psql "$DATABASE_URL" -f migrations/sisv_02_documents_rollback.sql
psql "$DATABASE_URL" -f migrations/sisv_01_tenant_config_rollback.sql
```
