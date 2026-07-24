# SISV — Sistema Integrado da Sinal Verde

Plataforma web SaaS multi-tenant para a gestão dos **processos de CNH** da Sinal Verde.
Desenvolvido pela **TELUN**.

> **Origem da base:** este produto foi construído a partir da base técnica do projeto
> NexoCRM (SaaS multi-tenant para despachantes), reaproveitando arquitetura,
> autenticação, modelo multi-tenant e infraestrutura. O SISV é mantido como
> **produto independente**; módulos fora do seu escopo permanecem desabilitados
> por tenant. Ver [`saas-multitenant/SISV.md`](saas-multitenant/SISV.md).

## Stack
- **Frontend:** Next.js 14 (App Router), React 18 — `saas-multitenant/`
- **Backend:** Node.js + Express — `saas-multitenant/backend/`
- **Banco:** PostgreSQL (isolado por tenant via `tenant_id`, autenticação JWT)

## Estrutura
```
saas-multitenant/
├── app/                    # Frontend Next.js
│   ├── sisv/               # Telas do SISV (processos, documentos, dashboard, config)
│   ├── components/         # Design system (ui.jsx) + Sidebar/PageHeader
│   ├── lib/                # Clientes de API, identidade (brand) e formatação
│   └── multas/             # Telas legadas da base (outros tenants)
└── backend/                # Express
    ├── config/             # Conexão e validação de ambiente (env.js)
    ├── migrations/         # SQL incremental idempotente (+ rollback)
    ├── models/ routes/     # Domínio e API
    ├── services/           # Armazenamento e validação de arquivos
    ├── scripts/            # Seed do tenant e criação segura de administrador
    └── tests/              # Suíte automatizada (node --test)
```

## Funcionalidades (MVP operacional)
Clientes · Processos de CNH · Etapas, status, tipos de serviço e setores **configuráveis
por tenant** · Responsável e distribuição (individual e em lote) · Controle de prazos ·
Filas com filtros combináveis, ordenação e exportação CSV · Documentos com categorias,
metadados, checklist por tipo de serviço e download controlado · Histórico automático ·
Dashboard operacional · Permissões por perfil · Isolamento completo entre tenants.

## Rodar localmente
```bash
# Backend (porta 5000) — requer DATABASE_URL e JWT_SECRET (ver backend/.env.example)
cd saas-multitenant/backend
npm install
npm test
node app.js
```
```bash
# Frontend (porta 3001) — ver .env.example
cd saas-multitenant
npm install
npm run dev
```

## Demonstração local (sem banco)
`backend/sisv-demo-server.js` sobe as rotas reais sobre um PostgreSQL em memória
(pg-mem) com dados fictícios. **Uso local apenas** — bloqueado com `NODE_ENV=production`.

## Documentação
| Documento | Conteúdo |
|---|---|
| [`SISV.md`](saas-multitenant/SISV.md) | Arquitetura, migrations, endpoints e configuração do tenant |
| [`HOMOLOGACAO.md`](saas-multitenant/HOMOLOGACAO.md) | Roteiro de homologação controlada |
| [`DEPLOY_SISV.md`](saas-multitenant/DEPLOY_SISV.md) | Deploy, backup e rollback |
| [`PRE_PRODUCAO.md`](saas-multitenant/PRE_PRODUCAO.md) | Checklist pré-produção |
