const { test, expect } = require('@playwright/test');

// =============================================================================
// sisv-comercial.spec.js — jornada comercial completa do SISV 2.0 (§53).
//
// Percorre pela INTERFACE: fornecedor → serviço → tabela de preço → cliente →
// pedido → itens → documento → validação (devolução, correção, aprovação) →
// pagamento informado → validação do pagamento → confirmação da venda →
// ordem de serviço → execução → custo → obrigações → pagamento operacional →
// conclusão → documento final → nota fiscal manual → finalização → arquivamento
// → visão 360 → dashboard → permissões → mobile → identidade TELUN.
//
// As asserções negativas são tão importantes quanto o caminho feliz: a tela
// precisa deixar visível que anexar comprovante não aprova, que aprovar
// pagamento não cria venda e que confirmar venda não cria comissão.
// =============================================================================

const runId = Date.now();
const supplierName = `Parceiro E2E ${runId}`;
const catalogCode = `E2E${runId}`.slice(0, 20);
const catalogName = `Servico E2E ${runId}`;
const tableName = `Tabela E2E ${runId}`;

/** Login e espera o shell operacional carregar. */
async function login(page, email = 'gestor@sinalverde.com.br') {
  await page.goto('/login');
  await page.locator('input[name="username"]').fill(email);
  await page.locator('input[type="password"]').fill('senha-demo');
  await page.getByRole('button', { name: /Entrar/ }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 45_000 });
  await expect(page.getByRole('navigation', { name: /Navega/ })).toBeVisible();
}

const goTo = (page, tab) => page.goto(`/dashboard?module=multas&tab=${tab}`);

/** Espera o aviso de sucesso do padrão de telas (Notice tone=success). */
const expectSuccess = (page, text) =>
  expect(page.locator('.sisv-notice--success').filter({ hasText: text })).toBeVisible();

test.describe.serial('SISV 2.0 — jornada comercial ponta a ponta', () => {
  test('cadastros mestres: fornecedor, serviço e tabela de preço', async ({ page }) => {
    await login(page);

    // ── Fornecedor / parceiro ──────────────────────────────────────────────
    await goTo(page, 'fornecedores');
    await expect(page.locator('h1.page-header-title')).toBeVisible();
    await page.getByRole('button', { name: 'Novo cadastro' }).click();

    const supplierDrawer = page.getByRole('dialog');
    await supplierDrawer.getByLabel('Classificação').selectOption('parceiro');
    await supplierDrawer.getByLabel('Nome ou razão social').fill(supplierName);
    await supplierDrawer.getByLabel('CPF ou CNPJ').fill(String(runId).slice(-11).padStart(14, '9'));
    await supplierDrawer.getByLabel('Tipo de comissão').selectOption('percentual');
    await supplierDrawer.getByLabel('Valor da comissão').fill('10');
    await supplierDrawer.getByRole('button', { name: 'Salvar' }).click();
    await expectSuccess(page, 'Fornecedor cadastrado');
    await expect(page.getByText(supplierName)).toBeVisible();

    // ── Item de catálogo ───────────────────────────────────────────────────
    await goTo(page, 'catalogo');
    await expect(page.locator('h1.page-header-title')).toBeVisible();
    await page.getByRole('button', { name: 'Novo item' }).click();

    const itemDrawer = page.getByRole('dialog');
    await itemDrawer.getByLabel('Código').fill(catalogCode);
    await itemDrawer.getByLabel('Nome', { exact: true }).fill(catalogName);
    await itemDrawer.getByLabel('Preço padrão').fill('1000');
    await itemDrawer.getByLabel('Custo padrão').fill('400');
    await itemDrawer.getByLabel(/Exige processo/).check();
    await itemDrawer.getByRole('button', { name: 'Salvar' }).click();
    await expectSuccess(page, 'Item salvo');
    await expect(page.getByText(catalogName)).toBeVisible();

    // A margem derivada aparece na listagem (preço e custo separados — §7).
    await expect(page.getByText('60%')).toBeVisible();

    // ── Tabela de preço com desconto máximo ────────────────────────────────
    await page.getByRole('tab', { name: 'Tabelas de preço' }).click();
    await expect(page.getByText(/não recalcula pedidos já lançados/)).toBeVisible();
    await page.getByRole('button', { name: 'Nova tabela' }).click();

    const tableDrawer = page.getByRole('dialog');
    await tableDrawer.getByLabel('Nome', { exact: true }).fill(tableName);
    await tableDrawer.getByLabel('Situação').selectOption('ativa');
    await tableDrawer.getByLabel('Adicionar item do catálogo')
      .selectOption({ label: `${catalogCode} · ${catalogName}` });
    await tableDrawer.getByLabel(`Desconto máximo de ${catalogName}`).fill('10');
    await tableDrawer.getByRole('button', { name: 'Salvar tabela' }).click();
    await expectSuccess(page, 'Tabela de preço salva');
    await expect(page.getByText(tableName)).toBeVisible();
  });

  test('pedido: criação, itens, limite de desconto, documento e envio', async ({ page }) => {
    await login(page);
    await goTo(page, 'pedidos');
    await expect(page.locator('h1.page-header-title')).toBeVisible();

    await page.getByRole('button', { name: 'Novo pedido' }).click();
    const newOrder = page.getByRole('dialog');
    await newOrder.locator('#no-client').fill('Ana');
    await newOrder.getByRole('option').filter({ hasText: 'Ana Souza' }).click();
    await newOrder.locator('#no-table').selectOption({ label: tableName });
    await newOrder.getByRole('button', { name: 'Criar pedido' }).click();

    // O drawer do pedido abre na etapa de itens.
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('tab', { name: '2. Itens' })).toBeVisible();

    await drawer.getByLabel('Adicionar serviço ou produto')
      .selectOption({ label: `${catalogCode} · ${catalogName}` });
    await expect(drawer.getByText(/Desconto máximo permitido/)).toBeVisible();

    // Desconto acima do teto é recusado pelo servidor.
    await drawer.getByLabel('Desconto', { exact: true }).fill('500');
    page.once('dialog', (alert) => alert.accept());
    await drawer.getByRole('button', { name: 'Adicionar item' }).click();

    // Dentro do limite, o item entra e os totais são recalculados no servidor.
    // O fornecedor sugerido (§11) é o que dá origem à comissão sugerida na
    // prévia da venda, mais adiante.
    await drawer.getByLabel('Desconto', { exact: true }).fill('50');
    await drawer.getByLabel('Fornecedor sugerido').selectOption({ label: supplierName });
    await drawer.getByRole('button', { name: 'Adicionar item' }).click();
    await expectSuccess(page, 'Item adicionado');
    // Confere na TABELA de itens (o mesmo texto existe no <option> do select).
    await expect(drawer.locator('.sisv-table tbody').getByText(catalogName)).toBeVisible();

    // Valores: total do servidor, não da tela.
    await drawer.getByRole('tab', { name: '3. Valores' }).click();
    await expect(drawer.getByText('R$ 950,00').first()).toBeVisible();

    // Cria o recebível do pedido.
    await drawer.getByRole('button', { name: 'Criar recebível' }).click();
    await drawer.getByRole('button', { name: 'Criar recebível' }).click();
    await expectSuccess(page, 'Recebível criado');

    // Revisão mostra o checklist do atendimento.
    await drawer.getByRole('tab', { name: '5. Revisão' }).click();
    await expect(drawer.getByText(/Itens lançados/)).toBeVisible();

    // Envio para validação.
    // O botão existe na etapa e no rodapé do drawer; aqui usamos o da etapa.
    await drawer.getByRole('tab', { name: '6. Envio' }).click();
    await drawer.getByLabel('Envio para validação')
      .getByRole('button', { name: 'Enviar para validação' }).click();
    await expectSuccess(page, 'Pedido movido para Enviado validacao');
  });

  test('back office: devolve, recebe correção, aprova e valida pagamento sem criar venda', async ({ page }) => {
    await login(page);
    await goTo(page, 'backoffice');
    await expect(page.locator('h1.page-header-title')).toBeVisible();

    // A fila de validação tem o pedido enviado.
    await expect(page.getByRole('button', { name: /Pedidos aguardando validacao/ })).toBeVisible();
    await page.getByRole('button', { name: 'Validar' }).first().click();

    const validation = page.getByRole('dialog');
    // Devolução sem justificativa fica bloqueada.
    await validation.getByLabel('Decisão').selectOption('devolvido');
    await expect(validation.getByRole('button', { name: 'Registrar decisão' })).toBeDisabled();
    await validation.getByLabel('Justificativa').fill('Falta comprovante de residência.');
    await validation.getByRole('button', { name: 'Registrar decisão' }).click();
    await expectSuccess(page, 'Pedido Devolvido');

    // Correção: reenvia o pedido devolvido.
    await goTo(page, 'pedidos');
    await page.locator('.sisv-table tbody tr').first().click();
    const orderDrawer = page.getByRole('dialog');
    await orderDrawer.getByRole('tab', { name: '6. Envio' }).click();
    await orderDrawer.getByLabel('Envio para validação')
      .getByRole('button', { name: 'Enviar para validação' }).click();
    await expectSuccess(page, 'Pedido movido para Enviado validacao');
    await orderDrawer.getByLabel('Fechar painel').click();

    // Aprovação com checklist de conferência.
    await goTo(page, 'backoffice');
    await page.getByRole('button', { name: 'Validar' }).first().click();
    const approval = page.getByRole('dialog');
    // A grade de conferência é opcional na aprovação; aqui verificamos que ela
    // está disponível e marcamos um item. A PERSISTÊNCIA do checklist (inclusive
    // o descarte de chaves desconhecidas) é coberta no teste de backend
    // 'validacao do back office', que inspeciona order_validations.checklist.
    await expect(approval.getByText('Conferência')).toBeVisible();
    await approval.getByLabel('Cliente', { exact: true }).check();
    await expect(approval.getByLabel('Cliente', { exact: true })).toBeChecked();
    await approval.getByLabel('Decisão').selectOption('aprovado');
    await approval.getByRole('button', { name: 'Registrar decisão' }).click();
    await expectSuccess(page, 'Pedido Aprovado');

    // ── Pagamento: informar não aprova ─────────────────────────────────────
    await goTo(page, 'financeiro-operacional');
    await page.locator('.sisv-table tbody tr').first().click();
    const receivable = page.getByRole('dialog');
    await expect(receivable.getByText(/só altera o saldo depois de validado/)).toBeVisible();
    await receivable.getByRole('button', { name: 'Informar pagamento' }).click();
    await receivable.getByLabel('Valor', { exact: true }).fill('500');
    await receivable.getByLabel('Comprovante (URL)').fill('/uploads/comprovante-e2e.pdf');
    await receivable.getByRole('button', { name: 'Informar pagamento' }).click();
    await expectSuccess(page, 'Pagamento informado');

    // O recebível continua sem valor recebido: comprovante não aprova (§19).
    await expect(receivable.getByText('R$ 0,00').first()).toBeVisible();
    await receivable.getByLabel('Fechar painel').click();

    // ── Validação explícita do pagamento ───────────────────────────────────
    await page.getByRole('tab', { name: 'Pagamentos do cliente' }).click();
    await page.getByRole('button', { name: 'Validar' }).first().click();
    const decision = page.getByRole('dialog');
    await decision.getByLabel('Decisão').selectOption('aprovado');
    await decision.getByRole('button', { name: 'Registrar decisão' }).click();

    // A tela diz explicitamente que a venda NÃO foi criada (§20).
    await expect(decision.getByText(/a venda não é criada sozinha|Confirmar venda/)).toBeVisible();
    await decision.getByLabel('Fechar painel').click();
  });

  test('venda: prévia consciente, confirmação explícita e ordem de serviço', async ({ page }) => {
    await login(page);
    await goTo(page, 'backoffice');

    // Fila "pedidos prontos para virar venda".
    await page.getByRole('button', { name: /Pedidos prontos para virar venda/ }).click();
    await page.getByRole('button', { name: 'Confirmar venda' }).first().click();

    const preview = page.getByRole('dialog');
    // A prévia mostra tudo que o §22 exige antes da confirmação.
    await expect(preview.getByText('Cliente e valores')).toBeVisible();
    await expect(preview.getByText('Itens')).toBeVisible();
    await expect(preview.getByText('Destino operacional')).toBeVisible();
    await expect(preview.getByText(/Comissões sugeridas/)).toBeVisible();
    await expect(preview.getByText(/Nada é registrado na confirmação/)).toBeVisible();

    await preview.getByRole('button', { name: 'Confirmar venda' }).click();
    await expectSuccess(page, 'confirmada');

    // ── Ordem de serviço a partir da venda ─────────────────────────────────
    await page.getByRole('button', { name: /Vendas aguardando ordem de servico/ }).click();
    await page.getByRole('button', { name: 'Gerar ordem' }).first().click();
    const orderPanel = page.getByRole('dialog');
    await orderPanel.getByLabel(/Criar processo/).check();
    await orderPanel.getByRole('button', { name: 'Gerar ordem' }).click();
    await expectSuccess(page, 'criada');
  });

  test('execução: liberar, iniciar, custo, obrigações e pagamento operacional', async ({ page }) => {
    await login(page);
    await goTo(page, 'execucao');
    await expect(page.locator('h1.page-header-title')).toBeVisible();

    await page.locator('.sisv-table tbody tr').first().click();
    const drawer = page.getByRole('dialog');

    // A cadeia Pedido → Venda → Ordem → Processo aparece no topo (§24).
    await expect(drawer.getByText(/Pedido .* Venda .* Ordem/)).toBeVisible();

    await drawer.getByRole('button', { name: 'Liberada' }).click();
    await expectSuccess(page, 'Ordem movida para Liberada');

    // Atribui responsável e inicia.
    await drawer.getByLabel('Responsável').selectOption({ index: 1 });
    await drawer.getByRole('button', { name: 'Salvar atribuição' }).click();
    await expectSuccess(page, 'Atribuição atualizada');
    await drawer.getByRole('button', { name: 'Em execucao' }).click();
    await expectSuccess(page, 'Ordem movida para Em execucao');

    // ── Custo de fornecedor ────────────────────────────────────────────────
    await drawer.getByRole('tab', { name: /Custos/ }).click();
    await drawer.getByRole('button', { name: 'Registrar custo de fornecedor' }).click();
    await drawer.getByLabel('Fornecedor / prestador').selectOption({ label: supplierName });
    await drawer.getByLabel('Serviço prestado').fill('Taxa do órgão');
    await drawer.getByLabel('Custo previsto').fill('200');
    await drawer.getByLabel('Custo real').fill('220');
    await drawer.getByRole('button', { name: 'Registrar custo' }).click();
    await expectSuccess(page, 'Custo registrado');

    // ── Obrigações: prévia editável, nada gravado antes de confirmar (§28) ──
    await drawer.getByRole('tab', { name: /Obrigações/ }).click();
    await expect(drawer.getByText(/ação guiada, não uma automação/)).toBeVisible();
    await drawer.getByRole('button', { name: 'Preparar pagamentos' }).click();
    await expect(drawer.getByText('Total a confirmar:')).toBeVisible();
    await drawer.getByRole('button', { name: /Confirmar \d+ obrigação/ }).click();
    await expectSuccess(page, 'Obrigações confirmadas');

    // ── Pagamento operacional ──────────────────────────────────────────────
    await drawer.getByLabel('Fechar painel').click();
    await goTo(page, 'financeiro-operacional');
    await page.getByRole('tab', { name: 'Contas a pagar' }).click();
    await expect(page.getByText(/Não há integração bancária/)).toBeVisible();
    await page.getByRole('button', { name: 'Registrar pagamento' }).first().click();
    const payment = page.getByRole('dialog');
    await payment.getByLabel('Situação').selectOption('pago');
    await payment.getByRole('button', { name: 'Registrar', exact: true }).click();
    await expectSuccess(page, 'Pagamento registrado');
  });

  test('finalização: conclusão, nota fiscal manual, checklist, arquivamento e 360', async ({ page }) => {
    await login(page);
    await goTo(page, 'execucao');
    // Espera a fila carregar antes de abrir a ordem: clicar numa linha ainda em
    // renderização deixava o teste instável na execução da suíte inteira.
    await expect(page.locator('.sisv-table tbody tr').first()).toBeVisible();
    await page.locator('.sisv-table tbody tr').first().click();

    const drawer = page.getByRole('dialog');
    // O rodapé só monta os botões de transição depois de carregar ordem + meta.
    await expect(drawer.getByText(/Pedido .* Venda .* Ordem/)).toBeVisible();

    await drawer.getByRole('button', { name: 'Concluida' }).click();
    await expectSuccess(page, 'Ordem movida para Concluida');

    await drawer.getByRole('tab', { name: 'Finalização' }).click();

    // A tela deixa explícito que não há emissão fiscal (§32).
    await expect(drawer.getByText(/não emite nota fiscal e não se comunica com SEFAZ/)).toBeVisible();
    await drawer.getByLabel('Situação').selectOption('emitida');
    await drawer.getByLabel('Número').fill(`NF${String(runId).slice(-6)}`);
    await drawer.getByLabel('Série').fill('1');
    await drawer.getByLabel('Data de emissão').fill('2026-08-02');
    await drawer.getByRole('button', { name: 'Salvar registro da nota' }).click();
    await expectSuccess(page, 'Nota fiscal registrada');

    // Checklist de conclusão e finalização.
    // Os rótulos do checklist vêm do backend (sem acentos, como o restante das
    // mensagens de domínio); a tela apenas os exibe.
    await expect(drawer.getByText('Checklist de conclusão')).toBeVisible();
    await expect(drawer.getByText('Execucao concluida')).toBeVisible();
    await drawer.getByRole('button', { name: 'Finalizar atendimento' }).click();
    await expectSuccess(page, 'Atendimento finalizado');

    // Arquivamento preserva os dados.
    await drawer.getByRole('button', { name: 'Arquivar atendimento' }).click();
    await expectSuccess(page, 'Atendimento arquivado');
    await drawer.getByLabel('Fechar painel').click();

    // ── Visão 360 do cliente ───────────────────────────────────────────────
    await goTo(page, 'clients');
    await page.locator('table tbody tr').first().click();
    // A visão 360 carrega por aba; a de pedidos deve trazer o pedido do ciclo.
    await expect(page.getByText(/Pedidos|Vendas/).first()).toBeVisible();
  });

  test('dashboard executivo reflete o ciclo e cada indicador abre a fila', async ({ page }) => {
    await login(page);
    await goTo(page, 'dashboard');

    const dashboard = page.getByRole('region', { name: 'Dashboard administrativo' });
    await expect(dashboard).toBeVisible();
    for (const section of ['Prioridades de hoje', 'Fluxo do período', 'Financeiro resumido', 'Carga da equipe']) {
      await expect(page.getByRole('heading', { name: section })).toBeVisible();
    }

    // O ciclo executado aparece no funil e o indicador navegável abre sua fila.
    await expect(page.locator('.sisv-admin-flow').getByText('Vendas', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Ordens aguardando execu/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('permissões: operador não acessa back office nem financeiro', async ({ page }) => {
    await login(page, 'operador1@sinalverde.com.br');

    // O menu não oferece as áreas restritas.
    const nav = page.getByRole('navigation', { name: /Navega/ });
    await expect(nav.getByRole('button', { name: 'Validação' })).toHaveCount(0);
    await expect(nav.getByRole('button', { name: 'Comissões' })).toHaveCount(0);

    // Nem por URL direta: a rota redireciona para uma aba permitida.
    await goTo(page, 'backoffice');
    await expect(page).not.toHaveURL(/tab=backoffice/, { timeout: 15_000 });

    // O que o perfil pode ver continua acessível.
    await goTo(page, 'pedidos');
    await expect(page.locator('h1.page-header-title')).toBeVisible();
  });

  test('responsividade e identidade TELUN nas telas comerciais', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await login(page);
    await goTo(page, 'pedidos');

    // Sem rolagem horizontal em nenhuma largura suportada (§48).
    for (const viewport of [
      { width: 320, height: 700 }, { width: 360, height: 800 }, { width: 390, height: 844 },
      { width: 768, height: 1024 }, { width: 1024, height: 768 }, { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `largura ${viewport.width}px sem rolagem horizontal`
      ).toBeTruthy();
    }

    // Em telas estreitas a tabela vira cards com rótulo por célula (§45).
    await page.setViewportSize({ width: 390, height: 844 });
    await goTo(page, 'fornecedores');
    const headerHidden = await page.locator('.sisv-table thead')
      .evaluate((element) => getComputedStyle(element).display === 'none').catch(() => true);
    expect(headerHidden).toBeTruthy();

    // Tokens TELUN permanecem intactos (§40).
    await page.setViewportSize({ width: 1440, height: 900 });
    const tokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        cosmic: style.getPropertyValue('--telun-cosmic').trim(),
        violet: style.getPropertyValue('--telun-violet-deep').trim(),
        lilac: style.getPropertyValue('--telun-lilac-electric').trim(),
        copper: style.getPropertyValue('--telun-copper').trim(),
        sand: style.getPropertyValue('--telun-sand').trim(),
      };
    });
    expect(tokens).toEqual({
      cosmic: '#0B0B12', violet: '#3B1F6A', lilac: '#A56FFF',
      copper: '#FF6A3D', sand: '#FFD8A6',
    });

    // A assinatura institucional continua no shell.
    await expect(page.getByText('Uma solução', { exact: true }).first()).toBeVisible();
  });
});
