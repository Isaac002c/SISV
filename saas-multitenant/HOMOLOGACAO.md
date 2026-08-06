# SISV — Checklist de Homologação

Roteiro de validação controlada antes da produção. Use **dados fictícios/anonimizados**
— nunca dados reais de outro tenant. Ambiente sugerido: banco de homologação isolado.

## Preparação
1. Aplicar migrations em ordem, de `000_nexos_schema.sql` até `sisv_11_client_fields_partners_contractors.sql`.
2. Provisionar tenant: `DATABASE_URL=... node scripts/seed_sisv.js` (cria tenant SISV, 4 usuários e catálogos — **não cria clientes/processos fictícios**).
3. Configurar `.env` (backend: `DATABASE_URL`, `JWT_SECRET`, `BASE_URL`; frontend: `BACKEND_URL`, `NEXT_PUBLIC_*`).

## Roteiro (31 itens)
| # | Item | Como validar | OK |
|---|------|--------------|----|
| 1 | Login | Entrar como gestor e como operador; token válido/expirado; usuário inativo | ☐ |
| 2 | Permissões | Operador não vê Configurações/Usuários/Histórico; rota direta redireciona; escrita admin retorna 403 | ☐ |
| 3 | Cadastro de cliente | Criar cliente (nome/CPF/telefone) | ☐ |
| 4 | Edição de cliente | Editar dados; abrir detalhe (dados/processos/documentos) | ☐ |
| 5 | Cadastro de processo | Novo processo vinculado ao cliente, com tipo/etapa/status/responsável/setor/prazo | ☐ |
| 6 | Edição de processo | "Editar dados" (número, protocolo, tipo, datas, prazo) | ☐ |
| 7 | Etapa | Mover etapa; histórico registra | ☐ |
| 8 | Status | Mudar status; histórico registra | ☐ |
| 9 | Responsável | Redistribuir; histórico com anterior→novo | ☐ |
| 10 | Setor | Trocar setor; histórico registra | ☐ |
| 11 | Prazo | Vencido (vermelho), hoje (âmbar), ≤7d, futuro, sem prazo; finalizado não conta | ☐ |
| 12 | Filtros | Chips de filtros ativos, remoção individual, limpar tudo, combinação, deep-link do dashboard | ☐ |
| 13 | Dashboard | KPIs reais; clique abre fila filtrada; vencidos/vencendo | ☐ |
| 14 | Documentos | Anexar com categoria+observação; filtrar/buscar; visualizar; baixar; arquivar/restaurar; remover (admin); checklist por serviço | ☐ |
| 15 | Histórico | Upload/etapa/status/redistribuição/setor/prazo/finalização/reabertura/arquivamento/remoção | ☐ |
| 16 | Distribuição em lote | Selecionar N; responsável e/ou setor; confirmação; atualiza fila; histórico só do que mudou | ☐ |
| 17 | Finalização | Finalizar; some dos indicadores de aberto; consulta como finalizado | ☐ |
| 18 | Reabertura | Reabrir (só admin); volta a contar prazos | ☐ |
| 19 | Exportação | Exportar CSV da fila filtrada (abre no Excel, acentos ok) | ☐ |
| 20 | Mobile | 360/390/768 px: fila em cards, filtros recolhíveis, drawer/modais na viewport, sem overflow | ☐ |
| 21 | Isolamento de tenant | Alterar id/URL não acessa dados/documentos de outro tenant (401/403/404) | ☐ |
| 22 | Campo adicional | Criar campo no catálogo, com tipo, dica e validação; editar sem duplicar a chave | ☐ |
| 23 | Exigência por serviço | Vincular o campo a um serviço; confirmar que outro serviço não passa a exigi-lo | ☐ |
| 24 | Cliente parcial | Cadastrar cliente sem serviço/campo extra; depois selecionar o serviço e completar o dado | ☐ |
| 25 | Barreira no pedido | Enviar pedido sem o campo obrigatório retorna pendência; preencher e reenviar funciona | ☐ |
| 26 | Cadastro de parceiro | Criar/editar parceiro com tabela, desconto, prazo, meio de pagamento, comissão e observação | ☐ |
| 27 | Contratante separado | Pedido mantém cliente atendido e mostra parceiro contratante sem trocar `client_id` | ☐ |
| 28 | Snapshot comercial | Alterar condições do parceiro não muda o pedido anterior | ☐ |
| 29 | Inativação de parceiro | Parceiro sai do seletor, nova contratação é bloqueada e histórico continua legível | ☐ |
| 30 | Fluxos seguintes | Prévia/venda/back office mostram cliente, contratante e condições aplicadas corretamente | ☐ |
| 31 | Permissões comerciais | Usuário sem `catalog:manage`, `suppliers:manage` ou `pricing:read` recebe 403 | ☐ |

## Segurança de arquivos (validar)
- Upload de `.exe`/`.zip` → rejeitado (extensão/MIME).
- PDF renomeado para `.png` (tipo forjado) → rejeitado (magic bytes).
- Download só pelo endpoint controlado (com token); URL de outro tenant → 404.
- Arquivo acima de 10MB → rejeitado.

## Dados de demonstração (§15)
- O **seed de produção** (`seed_sisv.js`) NÃO cria clientes/processos fictícios — apenas
  tenant, usuários e catálogos. Portanto, **não há dado operacional de demonstração** para remover.
- Dados de exemplo existem apenas no **servidor de demonstração local** (`sisv-demo-server.js`),
  que roda em Postgres **em memória** (pg-mem) e some ao reiniciar — nunca toca o banco real.
- Se algum dado de teste for inserido manualmente na homologação, identifique-o (ex.: nome iniciando
  com `[TESTE]`) e remova antes da produção. Consulta segura de conferência (somente leitura):
  ```sql
  SELECT id, name FROM clients WHERE tenant_id = '<sisv>' AND name ILIKE '[TESTE]%';
  ```

## Gate de saída
Testes backend, lint e build de produção verdes; sem erro crítico no console; isolamento e
permissões validados; documentos e histórico funcionando; fila utilizável no mobile.
