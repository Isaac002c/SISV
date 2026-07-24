# SISV — Checklist Pré-Produção

Preencher antes de liberar acesso real. Referências: `DEPLOY_SISV.md` (deploy/backup/rollback)
e `HOMOLOGACAO.md` (roteiro funcional).

## Repositório
- [ ] Remote aponta para o repositório **do SISV** (nunca para o Nexos)
- [ ] Branch correta e commits organizados por tema
- [ ] `git status` limpo (ou pendências justificadas)
- [ ] Nenhum `.env` real versionado (`git check-ignore` confirma)
- [ ] Sem segredos no diff (scan de `JWT_SECRET`, `DATABASE_URL`, tokens, chaves)
- [ ] Sem uploads/dumps/logs versionados
- [ ] CI verde (testes, lint, build, scan de secrets)

## Backend
- [ ] `DATABASE_URL` aponta para o banco **isolado do SISV** (confirmado nome/host)
- [ ] `JWT_SECRET` próprio, ≥32 caracteres, diferente de homologação
- [ ] `NODE_ENV=production` e startup validado sem erros (`config/env.js`)
- [ ] `FRONTEND_URL` definido, CORS **sem curinga**
- [ ] `BASE_URL` correto (links de arquivo)
- [ ] Migrations aplicadas na ordem (000 → sisv_01 → sisv_02) e conferidas
- [ ] `GET /health` retorna 200
- [ ] `GET /ready` retorna 200 (banco + armazenamento)
- [ ] Rate limit ativo (global e no login)
- [ ] Limite de payload e de upload (`UPLOAD_MAX_MB`) adequados
- [ ] Upload rejeita executáveis e tipo forjado (magic bytes)
- [ ] Respostas 500 genéricas; sem stack trace ao usuário
- [ ] Logs sem token, senha, `DATABASE_URL` ou caminho interno
- [ ] Modo demo **desligado** (`sisv-demo-server.js` bloqueado em produção)

## Frontend
- [ ] Build de produção sem erro
- [ ] `BACKEND_URL` apontando para a API correta
- [ ] Identidade **SISV / “Desenvolvido pela TELUN”** (sem Nexo/ChronosTek na interface)
- [ ] Rotas principais abrem (dashboard, processos, clientes, histórico, config)
- [ ] Mobile validado (360 / 390 / 768 px): fila em cards, filtros recolhíveis, sem overflow
- [ ] Console do navegador sem erro
- [ ] Mensagens de erro claras (sem detalhe técnico)

## Banco
- [ ] Backup completo gerado **antes** do deploy (dump + uploads) e guardado
- [ ] Rollback testado ao menos uma vez em homologação
- [ ] Tenant SISV criado (`seed_sisv.js`) com catálogos
- [ ] Administrador real criado via `create_admin.js` (senha fora do código)
- [ ] Usuários/dados de exemplo **removidos ou desativados**
- [ ] Índices presentes (tenant_id, etapa, prazo, responsável, categoria)

## Funcional (dados fictícios)
- [ ] Login (gestor e operacional)
- [ ] Cliente: criar, editar, abrir detalhe
- [ ] Processo: criar, editar dados, prazo
- [ ] Etapa, status, responsável, setor (com histórico)
- [ ] Documentos: anexar com categoria, baixar, arquivar, restaurar, remover
- [ ] Checklist documental por tipo de serviço
- [ ] Histórico completo e legível
- [ ] Filtros: aplicar, chips visíveis, remoção individual, limpar tudo
- [ ] Distribuição em lote (confirmação + histórico)
- [ ] Dashboard com números reais e atalhos funcionando
- [ ] Exportação CSV abre corretamente

## Segurança
- [ ] Isolamento entre tenants (dados, documentos, dashboard, filtros)
- [ ] IDOR: alterar id/URL não acessa recurso de outro tenant
- [ ] Operacional bloqueado em rota administrativa (menu, rota e API)
- [ ] Download de arquivo exige autenticação (sem URL pública previsível)
- [ ] Nenhum secret em log, resposta ou repositório
- [ ] Dados de demonstração ausentes na base de produção

## Assinatura
| Item | Responsável | Data |
|---|---|---|
| Homologação aprovada | | |
| Backup verificado | | |
| Liberação para produção | | |
