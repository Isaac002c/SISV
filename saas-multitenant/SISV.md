# SISV — Sistema Integrado da Sinal Verde (TELUN)

Produto SaaS multi-tenant para a operação de processos de **CNH** da
**Sinal Verde**. Reaproveita frontend, backend, banco, autenticação,
modelo multi-tenant, clientes, processos, documentos e histórico já existentes —
**sem criar arquitetura paralela** e **sem remover funcionalidades dos demais
tenants**.

> A entidade técnica legada `fines` é o **“processo”** do sistema. O SISV opera sobre
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

## SISV 1.0 operacional

A evolução 1.0 permanece sobre a entidade `fines` e sobre os logs existentes.
Não há arquitetura paralela nem módulo financeiro novo.

- **Pendências**: tipos configuráveis, prioridade, responsável, setor, prazo,
  transições de situação, conclusão rastreada, reabertura gerencial e soft-delete.
- **Meu Trabalho**: processos e pendências do usuário, atrasos, hoje, próximos
  prazos, documentos aguardados, processos parados e conclusões recentes.
- **Central de Atenção**: prazos, ausência de responsável/setor, aging,
  documentos faltantes, pendências críticas e verificações de qualidade.
- **Alertas internos**: atribuição, redistribuição, prazo, reabertura e menção,
  com chave de deduplicação e leitura individual/em lote.
- **Aging configurável**: limites padrão `2,5,10`, prazo de inatividade e prazo
  próximo configuráveis por tenant.
- **Templates de serviço**: etapa/status/setor iniciais, prazo padrão,
  checklist, pendências sugeridas e campos complementares validados.
- **Fila produtiva**: filtros na URL, visualizações privadas/compartilhadas,
  exportação segura, busca global e lote avançado com idempotência.
- **Gestão**: Dashboard 2.0, relatórios operacionais, carga por usuário,
  desativação com redistribuição, auditoria somente leitura e qualidade de dados.
- **Governança**: perfis `admin`, `manager`, `operator`, `seller` e `viewer`
  aplicados no backend e refletidos na interface.

## Identidade visual SISV · TELUN

SISV permanece como nome do produto. TELUN é a assinatura tecnológica e a
linguagem visual. A camada operacional usa superfícies claras e densidade
controlada; login e sidebar usam a camada institucional Cósmico.

- Paleta primitiva: Cósmico `#0B0B12`, Violeta Profundo `#3B1F6A`, Lilás
  Elétrico `#A56FFF`, Cobre Luminoso `#FF6A3D` e Dourado Areia `#FFD8A6`.
- Tokens semânticos e de componente ficam centralizados em `app/globals.css`.
- Tema `TELUN Light` é o tema operacional principal; os tokens de
  `TELUN Dark` estão preparados em `[data-theme='telun-dark']`.
- Login, sidebar, cabeçalho, cards, tabelas, drawers, estados vazios, gráficos,
  Central de Atenção, relatórios e recibos usam a nova identidade.
- Status de sucesso, informação, alerta e perigo mantêm cores semânticas
  reconhecíveis; cobre não substitui o vermelho de criticidade.
- `public/brand/telun/` e `public/brand/sisv/` são os pontos únicos de assets.
  Sem arquivos oficiais isolados, a aplicação usa fallback tipográfico e não
  redesenha o símbolo.

## Migrations (ordem)

```bash
psql "$DATABASE_URL" -f migrations/000_nexos_schema.sql          # base (se ainda não aplicada)
psql "$DATABASE_URL" -f migrations/sisv_01_tenant_config.sql     # config por tenant (idempotente)
psql "$DATABASE_URL" -f migrations/sisv_02_documents.sql         # organização documental (idempotente)
psql "$DATABASE_URL" -f migrations/sisv_03_operations.sql        # operação SISV 1.0 (idempotente)
psql "$DATABASE_URL" -f migrations/sisv_04_telun_identity.sql    # identidade visual TELUN
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
NEXT_PUBLIC_BRAND_COLOR=#A56FFF
NEXT_PUBLIC_BRAND_COLOR_DARK=#3B1F6A
NEXT_PUBLIC_SUPPORT_EMAIL=suporte@telun.com.br
NEXT_PUBLIC_TELUN_LOGO_URL=
NEXT_PUBLIC_TELUN_SYMBOL_URL=
NEXT_PUBLIC_SISV_FAVICON_URL=
```

A identidade específica do tenant (nome/cor/logo) também vive no registro do
tenant e pode ser editada por `PUT /api/tenant` (admin) ou no seed.
As três URLs de assets devem apontar apenas para arquivos oficiais isolados e
aprovados. Deixe-as vazias enquanto esses arquivos não estiverem disponíveis.

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
cd saas-multitenant/backend && npm test     # testes backend, segurança e isolamento
cd saas-multitenant && npm run test:e2e     # Playwright + banco pg-mem isolado
cd saas-multitenant && npm run test:visual  # 9 snapshots TELUN + contraste/responsividade
cd saas-multitenant && npm run perf:sisv    # massa sintética controlada
cd saas-multitenant && npm run lint         # lint
cd saas-multitenant && npm run build        # build de produção Next.js
```

O Playwright sobe automaticamente `backend/sisv-demo-server.js` na porta 5000
e o Next na porta 3001. O servidor demo é bloqueado quando
`NODE_ENV=production`. Os baselines cobrem login desktop/mobile, dashboard,
sidebar recolhida, Central de Atenção, fila, drawer, relatório e Meu Trabalho
mobile; também verificam a paleta, contraste de ação primária, reduced motion e
overflow nas larguras 320, 360, 390, 768, 1024 e 1440 px.

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
- **Ações em lote** em até 200 processos, com responsável, setor, etapa, status,
  prazo, nota, pendência e arquivamento apenas de finalizados. A API usa
  transação, chave de idempotência e informa atualizados/ignorados.
- Edição dos dados do processo (número, protocolo, tipo de serviço, data de
  abertura, prazo) na aba Visão geral do detalhe.

## API principal do SISV

- `GET/PUT /api/tenant`, `GET /api/tenant/me`, `GET /api/tenant/users`
- `GET /api/config` e CRUD em `/api/config/{stages,statuses,service-types,departments}` (escrita: admin)
- `GET /api/processes` (fila com filtros combináveis + paginação + ordenação), `GET /api/processes/dashboard`
- `POST /api/processes/batch/assign` — distribuição em lote (responsável e/ou setor)
- `POST /api/processes/batch/actions` — lote avançado transacional/idempotente
- `POST /api/processes`, `PUT /api/processes/:id`
- `PATCH /api/processes/:id/{stage,status,seller,department}`
- `POST /api/processes/:id/{notes,finalize,reopen}` (reopen: admin)
- `GET/POST/DELETE /api/processes/:id/documents`, `GET /api/processes/:id/logs`

### Endpoints operacionais 1.0

- `/api/tasks`: tipos, CRUD, filtros, iniciar, aguardar terceiro, concluir,
  cancelar, reabrir e exclusão lógica.
- `/api/alerts`: caixa interna, leitura individual, leitura total e geração
  idempotente de alertas de prazo.
- `/api/operations/settings`: parâmetros operacionais por tenant.
- `/api/operations/my-work`, `/attention`, `/dashboard`, `/quality`, `/search`.
- `/api/operations/saved-views`: listar, salvar, renomear, compartilhar,
  definir padrão e excluir.
- `/api/operations/reports/:type`, `/audit` e `/export/processes`.
- `/api/notes`: notas internas por processo, edição, menções e arquivamento.
- `/api/users/management/:id/workload` e `/:id/deactivate`.

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

- `app/sisv/DashboardV2.jsx` — painel operacional e produtividade.
- `app/sisv/Processos.jsx` — fila, URL, views, exportação e lote.
- `app/sisv/ProcessDrawer.jsx` — visão, andamento, pendências, documentos,
  notas e histórico no mesmo contexto.
- `app/sisv/MeuTrabalho.jsx` e `app/sisv/CentralAtencao.jsx`.
- `app/sisv/RelatoriosSISV.jsx` e `app/sisv/GovernancaSISV.jsx`.
- `app/sisv/ProcessosConfig.jsx` — catálogos, templates e parâmetros.
- `app/components/OperationalHeaderTools.jsx` — busca global e alertas.

## Medição local de performance

Comando: `npm run perf:sisv`. A medição usa `pg-mem`, sem rede, com 1.000
clientes, 5.000 processos, 10.000 movimentações, 2.500 documentos apenas como
metadados, 5.000 pendências, 20 responsáveis e 5 setores. Ela valida formato das
consultas e cardinalidade; não substitui benchmark no PostgreSQL da
infraestrutura alvo.

Resultado local de 24/07/2026 (mediana; p95 entre parênteses):

| Cenário | Tempo aproximado |
| --- | ---: |
| Fila paginada, 50 itens | 681 ms (899 ms) |
| Fila com filtros | 135 ms (163 ms) |
| Dashboard agregado | 107 ms (126 ms) |
| Busca global limitada | 445 ms (518 ms) |
| Exportação de 5.000 linhas | 491 ms (491 ms) |
| Histórico de um processo | 138 ms (218 ms) |
| Relatório etapa/setor | 292 ms (381 ms) |
| Central de Atenção | 69 ms (72 ms) |

O seed levou aproximadamente 49,3 s e 239 MB de heap. As consultas usam
paginação/limites e joins agregados; os índices da migration 03 cobrem caixa de
alertas, pendências, aging/prazo, carga, produtividade e auditoria. Para aceite
de produção, repetir a medição em PostgreSQL com volume e hardware
representativos.

## Pendências antes de um release produtivo

- Aplicar e validar as migrations 03 e 04 em uma cópia PostgreSQL do ambiente alvo;
  esta rodada não recebeu acesso ao banco real.
- Repetir o benchmark em PostgreSQL com plano de execução e latência da
  infraestrutura real; `pg-mem` é apenas o smoke reproduzível local.
- Planejar o upgrade controlado do Next. Em 24/07/2026,
  `npm audit --omit=dev` ainda aponta dois nós de severidade alta (`next` e seu
  `postcss` transitivo); a correção automática indicada exige salto principal
  para Next 16. O pacote vulnerável e não utilizado `js-cookie` foi removido.
- Executar auditoria formal de acessibilidade (WCAG/tecnologia assistiva); nesta
  rodada foram corrigidos os problemas evidentes e os fluxos críticos foram
  exercitados por teclado/semântica no Playwright.
- Receber os arquivos oficiais isolados TELUN/SISV (SVG/PNG transparente e
  favicon) e configurar os slots. O fallback atual é textual e explicitamente
  não representa uma implementação da logo oficial.

## Rollback das migrations
```bash
psql "$DATABASE_URL" -f migrations/sisv_04_telun_identity_rollback.sql
psql "$DATABASE_URL" -f migrations/sisv_03_operations_rollback.sql
psql "$DATABASE_URL" -f migrations/sisv_02_documents_rollback.sql
psql "$DATABASE_URL" -f migrations/sisv_01_tenant_config_rollback.sql
```

---

# SISV 2.0 — ecossistema comercial, back office, execução e financeiro operacional

Esta rodada estendeu o SISV de um sistema de processos para a jornada completa
do serviço: **Cliente → Pedido → Venda → Ordem de Serviço → Processo (quando
aplicável) → Finalização → Arquivamento**.

Nenhum módulo anterior foi removido, substituído ou recriado. Clientes,
processos, documentos seguros, pendências, Meu Trabalho, Central de Atenção,
alertas, aging, templates de serviço, campos personalizados, ações em lote,
visualizações salvas, busca global, auditoria e qualidade dos dados continuam
como estavam; o novo domínio se apoia neles.

## O que NÃO foi implementado (fora do escopo, por decisão da rodada)

Registrado de forma explícita para não haver leitura otimista do que existe:

- **Não há motor de automações.** Nenhum worker, fila assíncrona, cron, regra de
  evento ou ação em segundo plano foi criado para este domínio.
- **Não há integração fiscal.** Nota fiscal é apenas **registro manual** de
  número, série, chave, datas, valores e arquivos informados pelo usuário. O
  sistema não se comunica com SEFAZ, prefeitura, NFS-e, NF-e ou provedor fiscal,
  e **não emite** documento fiscal.
- **Não há integração nem conciliação bancária.** Marcar uma obrigação como paga
  registra data, forma e comprovante — nada mais.
- **Não há assinatura eletrônica.** Contrato é controle operacional: o sistema
  registra o documento, a via assinada e a situação.
- **Não há disparo de WhatsApp, e-mail, SMS, chatbot, OCR, IA ou portal do cliente.**

## Regra de ouro: nada acontece sozinho

Toda ação com impacto operacional ou financeiro exige iniciativa explícita do
usuário. As três fronteiras mais importantes, garantidas por teste:

| O que **não** acontece | O que acontece |
| --- | --- |
| Anexar comprovante **não** aprova pagamento | O pagamento entra como `informado`; só a validação explícita move o saldo do recebível |
| Aprovar pagamento **não** cria venda | A resposta devolve `sale_ready`, que apenas **libera** a ação “Confirmar venda” |
| Confirmar venda **não** cria obrigação nem comissão | A prévia calcula e mostra; só “Preparar pagamentos” → confirmar persiste |

`prepareObligations()` apenas calcula; `confirmObligations()` grava a lista que o
usuário revisou — por isso o servidor não reaproveita a prévia, respeitando
ajustes, remoções e inclusões feitas na tela.

## Modelagem

Migration não destrutiva `sisv_06_commercial_backoffice_execution.sql`
(rollback em `sisv_06_commercial_backoffice_execution_rollback.sql`).

Cadastros mestres
: `suppliers` (fornecedor, prestador, parceiro, indicador, correspondente e
  outro na **mesma** tabela, classificados por `kind` — §6 pede evitar uma
  tabela por classificação), `catalog_items`, `price_tables`, `price_table_items`.

Front office
: `orders`, `order_items`, `order_validations`.

Documentos
: `document_templates`, `generated_documents`, `commercial_contracts`.

Financeiro e vendas
: `receivables`, `customer_payments`, `sales`, `sale_items`.

Execução
: `service_orders`, `service_order_items`, `execution_costs`.

Obrigações e encerramento
: `payables`, `commissions`, `fiscal_documents`, `finalization_records`.

Apoio
: `commercial_counters` (numeração por tenant) e `commercial_history` (linha do
  tempo por entidade, complementando `activity_logs`).

### Decisões que valem registro

- **Cliente e processo não foram duplicados.** O processo continua sendo `fines`;
  a ordem de serviço aponta para ele em `service_order_items.process_id`. Serviço
  simples é executado na própria ordem, sem processo separado (§24).
- **Fotografia de preço.** `order_items` e `sale_items` guardam descrição, preço,
  custo e regra de comissão praticados. Mudar catálogo ou tabela depois **não**
  recalcula pedido nem venda — há teste dedicado a isso.
- **Fornecedor com histórico nunca é excluído.** Só inativado, com motivo, e
  permanece visível em vendas, pagamentos e auditoria anteriores.
- **Preço de venda e custo são colunas separadas**; custo pode ser nulo
  (“ainda não conhecido”) e a margem é derivada, nunca digitada.

### Integridade e concorrência

Transações em validação de pagamento, confirmação de venda, criação de ordem,
recebimento, preparação de obrigações, pagamento, finalização, cancelamento e
estorno. Além disso, barreiras **estruturais** no banco:

| Risco | Barreira |
| --- | --- |
| Venda duplicada | `UNIQUE (tenant_id, order_id)` em `sales` |
| Ordem duplicada | `UNIQUE (tenant_id, sale_id)` em `service_orders` |
| Recibo duplicado | índice parcial único por `payment_id` em `generated_documents` |
| Pagamento em dobro | índices parciais únicos por `execution_cost_id` e `commission_id` em `payables` |
| Comissão duplicada | índice parcial único por venda/item/beneficiário |
| Finalização duplicada | `UNIQUE (tenant_id, service_order_id)` em `finalization_records` |

Conflito de edição usa `row_version` e responde **HTTP 409**. O valor recebido de
um recebível é sempre **recalculado pela soma dos pagamentos aprovados** (não
incrementado), o que torna a operação idempotente.

## Rotas

| Prefixo | Domínio |
| --- | --- |
| `/api/commercial/suppliers` | fornecedores, prestadores e parceiros |
| `/api/commercial/catalog` | catálogo de serviços e produtos |
| `/api/commercial/price-tables` | tabelas de preço e itens |
| `/api/commercial/resolve-price` | preço vigente de um item |
| `/api/orders` | pedidos, itens e decisão do back office |
| `/api/receivables` | contas a receber operacionais |
| `/api/customer-payments` | pagamentos do cliente e validação manual |
| `/api/sales` | prévia e confirmação de venda |
| `/api/service-orders` | ordens, execução, custos e obrigações |
| `/api/payables` · `/api/commissions` | contas a pagar e comissões |
| `/api/doc-templates` · `/api/commercial-docs` · `/api/contracts-op` | documentos comerciais |
| `/api/fiscal-documents` | registro manual de nota fiscal |
| `/api/closure` | checklist, finalização, arquivamento e reabertura |
| `/api/backoffice` | filas, dashboard executivo, relatórios, visão 360 e busca |

Todas ficam sob `requireModule('processos')`, o mesmo gate da operação SISV, e
sob `checkPermission`.

`GET /api/orders/meta` e `GET /api/service-orders/meta` entregam situações e
transições ao frontend: o fluxo **não** é reimplementado na tela (§10).

## Templates de documento: segurança

O corpo é **texto puro** com marcadores `{{variavel}}`. `services/templateService.js`
recusa tags HTML, entidades, protocolos de script e interpolação de template
literal, e aceita **somente** variáveis da lista fechada `ALLOWED_FIELDS` —
qualquer outro marcador reprova o template ao salvar, em vez de ser ignorado na
renderização. Template publicado não tem o corpo alterado: cria-se nova versão.
O documento gerado guarda template, versão, usuário, data, entidade e checksum.

## Perfis (§38)

Aos perfis existentes (`admin`, `manager`, `operator`, `seller`, `viewer`) somam-se
quatro operacionais: `front_office`, `back_office`, `finance` e `operations`.
O enforcement é sempre no backend (`middlewares/checkPermission.js`); o menu
apenas esconde o que a role não pode usar. Fronteiras principais:

- **front_office** atende e monta pedido — não valida, não aprova pagamento, não confirma venda.
- **back_office** confere e decide — não administra catálogo, preços nem fornecedores.
- **finance** cuida de recebimentos, pagamentos e comissões — não confirma venda nem executa ordem.
- **operations** executa e finaliza — não valida pagamento e não arquiva.
- Reabertura de atendimento arquivado (`closure:reopen`) é exclusiva do administrador.

## Interface

Navegação reorganizada conforme §43 (Início, Atendimento, Back Office, Operação,
Financeiro operacional, Gestão, Cadastros, Configurações). As telas novas usam os
componentes compartilhados (`components/ui.jsx` e `sisv/comercial/shared.jsx`) e
os tokens TELUN já existentes — nenhuma cor nova foi introduzida. O título da
página vem do `PageHeader` (fonte única); as seções acrescentam trilha de
navegação, contexto e ações.

Em telas estreitas a tabela vira cards com rótulo por célula (`data-label`), sem
depender de rolagem horizontal. Cores semânticas seguem §47: lilás só para ação
principal e seleção; verde, âmbar, vermelho, azul e cobre reservados a status.

O dashboard operacional anterior foi **preservado**; as seções comerciais do §36
entram abaixo dele, e cada indicador com fila abre a lista correspondente.

## Verificação desta rodada

| Item | Resultado |
| --- | --- |
| Testes backend | 173 aprovados (153 anteriores + 20 do domínio comercial) |
| Playwright | 17 aprovados (8 anteriores + 9 da jornada comercial) |
| Lint | aprovado (apenas avisos pré-existentes de variáveis não usadas) |
| Build Next.js | aprovado |

Regressões corrigidas no baseline, antes da implementação:

- `npm test` no backend varria também `tests-postgres/`, que só roda pelo harness
  isolado; o script passou a mirar `tests/**/*.test.js`.
- O schema do `sisv-demo-server.js` estava defasado em relação às migrations 03–05
  (faltavam `workflow_*`, `sla_*`, `automation_*` e colunas como `fines.workflow_id`
  e `row_version`), o que derrubava dois testes E2E. Para o problema não se repetir
  em silêncio, foram adicionados `scripts/pgmem-schema-gen.js` (gera o bloco a
  partir da migration) e `scripts/check-demo-schema.js` (falha se o demo ficar
  defasado).

Bugs reais encontrados e corrigidos durante os testes:

- O validador de template rejeitava **todo** marcador válido (o padrão de
  “expressão” casava com o `}` final). A validação passou a exigir um nome de
  variável bem formado e conferir a lista autorizada.
- Formulários fechavam mesmo quando o servidor recusava a operação, descartando o
  que o usuário havia digitado (por exemplo, ao corrigir um desconto acima do teto).
- O painel de validação assumia o pedido (mudando a versão) e depois enviava a
  decisão com a versão antiga, gerando um 409 sem conflito real.
- Um `<label for>` que envolvia o próprio checkbox fazia o clique disparar duas
  vezes e a caixa voltar ao estado original.

## Pendências reais do SISV 2.0

- As migrations 05–11, sua idempotência e os rollbacks 05, 06 e 11 foram
  validados pelo harness em PostgreSQL real isolado. O banco de produção não foi
  alterado; backup e ensaio no ambiente alvo continuam obrigatórios antes do release.
- Os índices `UNIQUE` parciais e funcionais da migration 06 agora são cobertos em
  PostgreSQL real por `tests-postgres/commercial-postgres.test.js`.
- Não há benchmark do domínio comercial com volume representativo.
- Anexo de comprovante e de contrato é registrado por **URL**; a integração com o
  módulo de upload seguro para estes documentos ficou fora desta rodada.
- Um passo do E2E (marcar várias caixas da grade de conferência em sequência) não
  é exercido pela interface: sob automação, o Chromium engole o clique sintético
  em uma delas, embora o alvo esteja correto e sem sobreposição, e o clique real
  funcione. A persistência do checklist é coberta pelo teste de backend, que
  inspeciona `order_validations.checklist`.

## Rollback da migration 06
```bash
psql "$DATABASE_URL" -f migrations/sisv_06_commercial_backoffice_execution_rollback.sql
```
> Apaga os dados comerciais (pedidos, vendas, ordens, recebimentos, obrigações,
> comissões, documentos, notas e finalizações). Faça backup antes.

## Extensão SISV 2.1

Campos de cliente configuráveis por serviço, parceiros com condições comerciais
e a separação entre cliente atendido e contratante estão documentados em
`SISV_21_CLIENTES_PARCEIROS.md`.

Novas rotas principais:

- `/api/client-fields` — definições, requisitos por serviço e validação do pedido;
- `/api/commercial/partners` — seleção segura de parceiros ativos;
- `/api/orders` — aceita `contractor_type` e `contractor_partner_id` e devolve o
  snapshot imutável em `applied_commercial_terms`.

Migration e rollback:

```bash
psql "$DATABASE_URL" -f migrations/sisv_11_client_fields_partners_contractors.sql
psql "$DATABASE_URL" -f migrations/sisv_11_client_fields_partners_contractors_rollback.sql
```
