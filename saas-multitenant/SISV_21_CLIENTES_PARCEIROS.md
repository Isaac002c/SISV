# SISV 2.1 — clientes por serviço, parceiros e contratante

Esta extensão mantém o desenho existente do SISV e adiciona três capacidades:

1. campos de cliente configuráveis por tenant e obrigatórios somente para os serviços escolhidos;
2. parceiros administrados no cadastro unificado de fornecedores, com condições comerciais próprias;
3. separação explícita entre o cliente atendido e quem contrata o pedido.

Não há nova stack, serviço externo ou variável de ambiente. O backend continua em
Node/Express, o frontend em Next.js e a persistência em PostgreSQL.

## Decisões de modelagem

- `clients.additional_data` guarda somente campos adicionais em JSONB. CPF, nascimento,
  CNH, primeira habilitação, telefone, e-mail e endereço continuam nas colunas nativas.
- `client_field_definitions` descreve campos nativos e adicionais por tenant. Um gatilho
  cria as sete definições nativas também para tenants cadastrados depois da migration.
- `service_client_field_requirements` relaciona um serviço de `catalog_items` aos campos
  exigidos. Um serviço sem relações não exige campo extra.
- Parceiro continua em `suppliers`, com `kind = 'parceiro'`; não existe cadastro duplicado.
- `orders.client_id` permanece sendo o cliente atendido. `contractor_type` informa se o
  contratante é o próprio cliente ou um parceiro; neste último caso,
  `contractor_partner_id` identifica o parceiro.
- `orders.applied_commercial_terms` fotografa nome, documento, tabela, desconto, prazo,
  meio de pagamento, comissão e observações comerciais no momento da contratação.
  Alterações posteriores no parceiro não reescrevem pedidos históricos.
- Condições como desconto são referência comercial. Apenas a tabela de preço escolhida
  participa da resolução de preço; não há recálculo financeiro silencioso.

Pedidos anteriores à migration ficam com `contracting_model_version = 1`, cliente como
contratante e comportamento legado. Novos pedidos usam a versão 2 e precisam conter ao
menos um serviço antes de seguir para validação ou venda.

## API

Todas as rotas usam a autenticação, o tenant do token, a checagem de usuário ativo, o
gating do módulo `processos` e as permissões já existentes.

### Campos de cliente

| Método e rota | Uso | Permissão |
| --- | --- | --- |
| `GET /api/client-fields?service_ids=<uuid,...>&client_id=<uuid>` | Lista definições, exigências agregadas e, opcionalmente, valores do cliente | `clients:read` |
| `POST /api/client-fields` | Cria campo adicional | `catalog:manage` |
| `PUT /api/client-fields/:id` | Altera nome, tipo, regra, ordem ou atividade permitida | `catalog:manage` |
| `GET /api/client-fields/services/:serviceId/requirements` | Consulta a configuração de um serviço | `catalog:read` |
| `PUT /api/client-fields/services/:serviceId/requirements` | Substitui a configuração ativa do serviço | `catalog:manage` |
| `GET /api/client-fields/orders/:orderId/validation` | Mostra campos ausentes ou inválidos no pedido | `orders:read` |

Exemplo de criação de campo:

```json
{
  "field_key": "renavam",
  "label": "RENAVAM",
  "field_type": "document",
  "sort_order": 80,
  "validation_rules": {
    "min_length": 9,
    "max_length": 11,
    "hint": "Informe apenas os dígitos"
  }
}
```

Exemplo de configuração de um serviço:

```json
{
  "fields": [
    {
      "field_definition_id": "<uuid>",
      "required": true,
      "validation_rules": { "min_length": 9 }
    }
  ]
}
```

O cadastro de cliente aceita `additional_data`:

```json
{
  "name": "Cliente atendido",
  "cpf": "12345678900",
  "additional_data": {
    "renavam": "00123456789"
  }
}
```

Chaves não configuradas para o tenant e valores que violam tipo, tamanho, faixa ou
expressão regular são recusados pelo backend.

### Parceiros

Parceiros são criados e editados pelas rotas existentes de fornecedores:

- `POST /api/commercial/suppliers`;
- `PUT /api/commercial/suppliers/:id`;
- `POST /api/commercial/suppliers/:id/status` para inativar ou reativar;
- `GET /api/commercial/partners` para o seletor seguro de parceiros ativos.

Exemplo:

```json
{
  "kind": "parceiro",
  "legal_name": "Parceiro Exemplo",
  "document": "11222333000144",
  "default_price_table_id": "<uuid>",
  "discount_type": "percentual",
  "discount_value": 10,
  "payment_terms": "30 dias",
  "payment_method": "boleto",
  "commission_type": "percentual",
  "commission_value": 5,
  "commercial_notes": "Condição aprovada pelo comercial"
}
```

O endpoint de seleção exige `suppliers:read` e `pricing:read`, retorna apenas parceiros
ativos e não expõe dados bancários nem chave Pix. Parceiros inativos permanecem nos
pedidos históricos, mas não podem ser escolhidos para nova contratação.

### Pedidos e contratante

Criação com o próprio cliente como contratante:

```json
{
  "client_id": "<uuid-do-cliente-atendido>",
  "contractor_type": "client"
}
```

Criação com parceiro contratante:

```json
{
  "client_id": "<uuid-do-cliente-atendido>",
  "contractor_type": "partner",
  "contractor_partner_id": "<uuid-do-parceiro>"
}
```

Se `price_table_id` não for informado, a tabela padrão do parceiro é aplicada. A resposta
e o detalhe do pedido expõem `contractor_type`, `contractor_partner_id`, nome do
contratante e `applied_commercial_terms`.

As barreiras de campos obrigatórios são executadas ao:

- enviar o pedido para validação;
- aprovar o pedido no back office;
- pré-visualizar ou confirmar a venda.

Rascunhos e cadastros parciais continuam permitidos. Quando faltarem dados, o backend
responde com código de domínio `CLIENT_REQUIRED_FIELDS_MISSING` e detalhes por campo e
serviço; a interface apresenta a pendência na revisão do pedido.

## Migration, deploy gradual e rollback

Aplicar depois de `sisv_10_client_soft_delete.sql` e antes de publicar o novo backend:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f backend/migrations/sisv_11_client_fields_partners_contractors.sql
```

A migration é transacional e idempotente. O deploy seguro é: backup, migration, backend,
frontend e smoke test. Não publicar o backend novo antes da migration, porque ele consulta
as novas colunas.

Rollback estrutural:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f backend/migrations/sisv_11_client_fields_partners_contractors_rollback.sql
```

O rollback remove dados adicionais, definições, relações, condições novas e snapshots;
por isso exige backup confirmado e retorno do backend/frontend à versão anterior. Ele
preserva clientes, fornecedores, catálogo, pedidos e todo o domínio anterior.

## Homologação mínima

1. criar um campo adicional e vinculá-lo a um serviço;
2. confirmar que outro serviço continua sem exigir esse campo;
3. salvar cliente parcial sem serviço e, depois, preencher o campo no contexto correto;
4. verificar que o pedido não segue sem o campo e segue após o preenchimento;
5. criar e editar parceiro com tabela, desconto, prazo, meio de pagamento e comissão;
6. criar pedido com cliente atendido diferente do parceiro contratante;
7. alterar o parceiro e confirmar que o pedido antigo conserva o snapshot anterior;
8. inativar o parceiro, confirmar que ele sai do seletor e que o histórico permanece;
9. confirmar a venda e verificar cliente atendido, parceiro e valores nos fluxos seguintes;
10. repetir os cenários com usuário sem permissão e com outro tenant.

## Resultado da implementação e validação — 2026-08-05

O diagnóstico confirmou a stack existente: Next.js 14 no frontend, Express no
backend, acesso SQL por `pg`, migrations SQL ordenadas e PostgreSQL. O cadastro
unificado `suppliers` já representava parceiros e comissões; por isso a extensão
reutiliza `kind = 'parceiro'`, sem criar uma entidade concorrente.

Além do seletor seguro de parceiros, as respostas JSON e CSV do cadastro de
fornecedores agora são redigidas conforme as permissões: banco e Pix exigem
`suppliers:manage`; tabela, desconto, prazo, meio de pagamento, comissão e notas
comerciais exigem `pricing:read`.

| Verificação | Resultado |
| --- | --- |
| Testes unitários e de integração do backend | 184/184 aprovados |
| PostgreSQL real isolado | 18/18; migrations 000→11, idempotência, rollback 11/06/05 e reaplicação aprovados |
| E2E funcional Playwright | 15/15 aprovados, incluindo o fluxo cliente/serviço/parceiro/contratante |
| Schema do servidor demo | 69 tabelas, sem divergência |
| ESLint | aprovado; somente avisos anteriores fora desta extensão |
| Build de produção Next.js | aprovado |

O snapshot visual legado do login não foi atualizado: sua imagem-base já divergia
da tela institucional/username existente antes desta extensão. Os testes funcionais
de login foram alinhados ao contrato atual e passaram.

### Publicação

Nenhum ambiente remoto foi alterado. O projeto Vercel `sisv` pôde ser consultado,
mas não existe neste workspace acesso ao backend/PostgreSQL da VPS: faltam
`deploy/sisv-backend.env`, `deploy/sisv-tunnel.env`, Docker e uma sessão SSH. Como
o frontend novo depende da migration 11 e das novas rotas, publicar apenas o
frontend seria incompatível e foi deliberadamente evitado.

O trabalho está na branch `codex/client-service-partners-contractors`. Não foi
criado commit porque a branch nasceu sobre um worktree com 152 caminhos já
alterados ou não rastreados, inclusive arquivos centrais desta implementação;
agrupar esses arquivos absorveria alterações anteriores sem autoria segura.
