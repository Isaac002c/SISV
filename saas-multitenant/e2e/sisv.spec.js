const { test, expect } = require('@playwright/test');

const runId = Date.now();
const createdProcess = `E2E-${runId}`;
const createdTask = `Pendência ${createdProcess}`;
const createdClient = `Cliente E2E ${runId}`;
const createdUser = `Operador E2E ${runId}`;
const createdUsername = `operador.e2e.${runId}`;
const createdUserEmail = `e2e.${runId}@sinalverde.test`;

async function login(page, email) {
  await page.goto('/login');
  await page.locator('input[name="username"]').fill(email);
  await page.locator('input[type="password"]').fill('senha-demo');
  const responsePromise = page.waitForResponse((response) => response.url().endsWith('/auth/login'));
  await page.getByRole('button', { name: 'Entrar' }).click();
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  const authState = await page.evaluate(() => ({
    token: Boolean(localStorage.getItem('token')),
    user: localStorage.getItem('user'),
  }));
  expect(authState.token).toBeTruthy();
  expect(authState.user).toContain(email);
  // The first dashboard navigation compiles the large route in Next dev mode.
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 45_000 });
  await expect(page.getByRole('navigation', { name: /Navega/ })).toBeVisible();
}

async function selectDifferentOption(select) {
  const current = await select.inputValue();
  const options = await select.locator('option').evaluateAll((items) =>
    items.map((item) => ({ value: item.value, disabled: item.disabled })));
  const next = options.find((option) => option.value && option.value !== current && !option.disabled);
  if (!next) throw new Error('Nenhuma opção alternativa disponível.');
  await select.selectOption(next.value);
}

async function saveFlowChange(page, drawer, buttonIndex, endpointSuffix) {
  const actionResponse = page.waitForResponse((response) => {
    const path = new URL(response.url()).pathname;
    return response.request().method() === 'PATCH' && path.endsWith(endpointSuffix);
  });
  const reloadResponse = page.waitForResponse((response) => {
    const path = new URL(response.url()).pathname;
    return response.request().method() === 'GET' && /^\/api\/processes\/[^/]+$/.test(path);
  });
  await drawer.getByRole('button', { name: 'Salvar' }).nth(buttonIndex).click();
  expect((await actionResponse).ok()).toBeTruthy();
  expect((await reloadResponse).ok()).toBeTruthy();
}

test.describe.serial('SISV 1.0 - fluxos críticos', () => {
  test('administrador cria usuário operacional e cliente fictício', async ({ page }) => {
    await login(page, 'gestor@sinalverde.com.br');

    await page.getByRole('button', { name: /Usu.rios/ }).click();
    await expect(page.getByRole('heading', { name: /Equipe, perfis e m.dulos/ })).toBeVisible();
    await page.getByRole('button', { name: /Novo usu.rio/i }).click();
    const userDialog = page.getByRole('dialog', { name: /Novo usu.rio/i });
    await userDialog.getByLabel(/Nome completo/).fill(createdUser);
    await userDialog.getByLabel(/Usu.rio de acesso/).fill(createdUsername);
    await userDialog.getByLabel(/Senha provis.ria/).fill('SenhaSegura123!');
    await userDialog.getByRole('button', { name: /Personalizado/ }).click();
    await userDialog.locator('.access-module-options label').filter({ hasText: /Opera/ })
      .getByRole('checkbox').check();
    await userDialog.getByRole('button', { name: /Criar usu.rio/i }).click();
    await expect(page.getByText(`@${createdUsername}`, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Clientes', exact: true }).click();
    await page.getByRole('button', { name: /Novo Cliente/ }).click();
    const clientDialog = page.getByRole('dialog', { name: /Novo Cliente/ });
    await clientDialog.getByLabel(/Nome completo/).fill(createdClient);
    await clientDialog.getByLabel('CPF').fill('12345678901');
    await clientDialog.getByLabel('CNH').fill(`CNH${String(runId).slice(-8)}`);
    await clientDialog.getByLabel('E-mail').fill(createdUserEmail);
    await clientDialog.getByRole('button', { name: 'Criar cliente' }).click();
    await expect(page.getByText(createdClient, { exact: true })).toBeVisible();
  });

  test('processo com template percorre documento, checklist, movimento, redistribuição, pendência e histórico', async ({ page }) => {
    await login(page, 'gestor@sinalverde.com.br');
    await page.getByRole('button', { name: 'Processos', exact: true }).click();
    await page.getByRole('button', { name: /Novo Processo/ }).click();

    const createDialog = page.getByRole('dialog', { name: /Novo Processo/ });
    const selects = createDialog.locator('select');
    const clientValue = await selects.nth(0).locator('option')
      .filter({ hasText: createdClient }).getAttribute('value');
    await selects.nth(0).selectOption(clientValue);
    await selects.nth(1).selectOption({ index: 1 });
    await expect(createDialog.getByText(/Template demo/)).toBeVisible();
    await expect(createDialog.getByText(/Criar 1 pend.ncia/)).toBeVisible();
    await createDialog.getByRole('checkbox').check();
    await createDialog.getByPlaceholder('Interno / do cliente').fill(createdProcess);
    await createDialog.getByRole('button', { name: 'Criar processo' }).click();
    await expect(page.getByText(createdProcess, { exact: true })).toBeVisible();

    await page.getByText(createdProcess, { exact: true }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText(createdProcess);

    await drawer.getByRole('button', { name: /Documentos/ }).click();
    await expect(drawer.getByText(/Checklist documental/)).toBeVisible();
    await expect(drawer.getByText(/pendente/).first()).toBeVisible();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    );
    await drawer.locator('select').first().selectOption({ index: 1 });
    await drawer.locator('input[type="file"]').setInputFiles({
      name: `documento-${runId}.png`,
      mimeType: 'image/png',
      buffer: png,
    });
    await expect(drawer.getByText(`documento-${runId}.png`, { exact: true })).toBeVisible();
    await expect(drawer.getByText(/recebido/).first()).toBeVisible();

    await drawer.getByRole('button', { name: /Andamento/ }).click();
    const flowSelects = drawer.locator('select');
    await selectDifferentOption(flowSelects.nth(0));
    await saveFlowChange(page, drawer, 0, '/stage');
    await flowSelects.nth(2).selectOption({ label: createdUser });
    await saveFlowChange(page, drawer, 2, '/seller');

    await drawer.getByRole('button', { name: /Pend.ncias/ }).click();
    await drawer.getByRole('button', { name: /Nova pend.ncia/ }).click();
    await drawer.getByLabel(/T.tulo/).fill(createdTask);
    const taskForm = drawer.locator('form').filter({ hasText: /Nova pend.ncia/ });
    await taskForm.locator('select').nth(1).selectOption('critica');
    await taskForm.locator('select').nth(2).selectOption({ label: createdUser });
    await drawer.getByRole('button', { name: /Criar pend.ncia/ }).click();
    await expect(drawer.getByText(createdTask, { exact: true })).toBeVisible();

    page.once('dialog', (dialog) => dialog.accept('Conferência concluída no E2E'));
    const taskCard = drawer.getByRole('article', { name: createdTask });
    await taskCard.getByRole('button', { name: 'Concluir' }).click();
    await expect(drawer.getByText('1 pendência(s) ativa(s)')).toBeVisible();
    await drawer.getByLabel(/Filtrar situa/).selectOption('concluidas');
    await expect(drawer.getByText(createdTask, { exact: true })).toBeVisible();
    await expect(drawer.getByText('Conferência concluída no E2E')).toBeVisible();

    await drawer.getByRole('button', { name: /Notas internas/ }).click();
    await drawer.getByLabel(/Nova nota interna/).fill(`Nota operacional ${createdProcess} @${createdUser}`);
    await drawer.getByRole('button', { name: 'Adicionar nota' }).click();
    await expect(drawer.getByText(new RegExp(`Nota operacional ${createdProcess}`))).toBeVisible();

    await drawer.getByRole('button', { name: /Hist.rico/ }).click();
    await expect(drawer.getByText(/Pend.ncia conclu.da/)).toBeVisible();
    await expect(drawer.getByText(/Mudan.a de etapa/)).toBeVisible();
    await drawer.getByRole('button', { name: /Fechar painel/ }).click();
  });

  test('fila preserva URL, salva visão, executa lote, busca global, exporta e abre dashboard', async ({ page }) => {
    await login(page, 'gestor@sinalverde.com.br');
    await page.getByRole('button', { name: 'Processos', exact: true }).click();

    const search = page.getByPlaceholder(/Buscar por cliente, CPF/);
    await search.fill(createdProcess);
    await expect(page).toHaveURL(new RegExp(`q=${createdProcess}`), { timeout: 10_000 });
    await expect(page.getByText(createdProcess, { exact: true })).toBeVisible();

    page.once('dialog', (dialog) => dialog.accept(`Visão ${createdProcess}`));
    await page.getByRole('button', { name: /Salvar visualiza/ }).click();
    await expect(page.getByText(`Visão ${createdProcess}`, { exact: true })).toBeVisible();

    await page.getByLabel(`Selecionar ${createdProcess}`).check();
    await page.getByText(/Mais a..es em lote/).click();
    await page.getByLabel(/Nota em lote/).fill(`Lote ${createdProcess}`);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
    await expect(page.getByText(/selecionado/)).toHaveCount(0);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /Exportar CSV/ }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.csv$/);

    const global = page.getByLabel('Busca global');
    await global.fill(createdProcess);
    const results = page.getByLabel('Resultados da busca');
    await expect(results.getByText(createdProcess, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Dashboard administrativo' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Prioridades de hoje/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Fluxo do per.odo/ })).toBeVisible();
  });

  test('operador recebe alertas e não acessa superfícies administrativas', async ({ page }) => {
    await login(page, createdUsername);

    await expect(page.getByRole('button', { name: /Usu.rios/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Auditoria/ })).toHaveCount(0);
    await page.goto('/dashboard?module=multas&tab=users');
    await expect(page).toHaveURL(/tab=processos/);

    await page.getByRole('button', { name: /Meu Trabalho/ }).click();
    await expect(page.getByText(/Meu Trabalho/).first()).toBeVisible();
    await expect(page.getByText(createdProcess).first()).toBeVisible();

    const alertButton = page.getByLabel(/alertas n.o lidos/);
    await expect(alertButton).toHaveAttribute('aria-label', /^[1-9]\d* alertas/);
    await alertButton.click();
    await expect(page.getByText(/Processo atribuido a voce/)).toBeVisible();
    await page.getByRole('button', { name: /Marcar todos como lidos/ }).click();
    await expect(alertButton).toHaveAttribute('aria-label', /^0 alertas/);
  });

  test('telas gerenciais e viewport móvel permanecem operáveis', async ({ page }) => {
    await login(page, 'gestor@sinalverde.com.br');
    for (const [button, heading] of [
      [/Central de Aten/, /Central de Aten/],
      [/Relat.rios/, /Relat.rios/],
      [/Qualidade/, /Qualidade/],
      [/Auditoria/, /Auditoria/],
    ]) {
      await page.getByRole('button', { name: button }).click();
      await expect(page.getByText(heading).first()).toBeVisible();
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Abrir menu' }).click();
    await expect(page.getByRole('navigation', { name: /Navega/ })).toBeVisible();
    await page.getByRole('button', { name: 'Processos', exact: true }).click();
    await expect(page.getByRole('button', { name: /Novo Processo/ })).toBeVisible();
  });
});
