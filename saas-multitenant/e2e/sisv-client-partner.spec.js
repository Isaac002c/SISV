const { test, expect } = require('@playwright/test');

const runId = String(Date.now());
const fieldLabel = `Registro E2E ${runId}`;
const fieldKey = `registro_${runId}`;
const serviceCode = `CP${runId}`.slice(0, 20);
const serviceName = `Servico contratante ${runId}`;
const partnerName = `Parceiro contratante ${runId}`;
const clientName = `Cliente atendido ${runId}`;

async function login(page) {
  await page.goto('/login');
  await page.locator('input[name="username"]').fill('gestor.sinalverde');
  await page.locator('input[name="password"]').fill('senha-demo');
  await page.getByRole('button', { name: /Entrar/ }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 45_000 });
}

const goTo = (page, tab) => page.goto(`/dashboard?module=multas&tab=${tab}`);

test('campo por servico, cliente atendido e parceiro contratante percorrem a interface', async ({ page }) => {
  // O servidor Next da suite compila cada modulo sob demanda nesta jornada longa.
  test.setTimeout(360_000);
  await login(page);

  // Campo adicional configuravel.
  await goTo(page, 'catalogo');
  await page.getByRole('tab', { name: 'Campos do cliente' }).click();
  await page.getByRole('button', { name: 'Novo campo' }).click();
  let drawer = page.getByRole('dialog');
  await drawer.locator('#cf-label').fill(fieldLabel);
  await drawer.locator('#cf-key').fill(fieldKey);
  await drawer.locator('#cf-type').selectOption('document');
  await drawer.getByRole('button', { name: 'Salvar campo' }).click();
  await expect(page.getByText(fieldLabel).first()).toBeVisible();

  // Servico que exige somente o campo criado.
  await page.getByRole('tab').filter({ hasText: /produtos/i }).click();
  await page.getByRole('button', { name: 'Novo item' }).click();
  drawer = page.getByRole('dialog');
  await drawer.locator('#cat-code').fill(serviceCode);
  await drawer.locator('#cat-name').fill(serviceName);
  await drawer.locator('#cat-price').fill('275');
  await drawer.getByLabel(fieldLabel).check();
  await drawer.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.locator('.sisv-notice--success').filter({ hasText: 'Item salvo' })).toBeVisible();

  // Parceiro com condicoes comerciais; dados bancarios nao participam do seletor.
  await goTo(page, 'fornecedores');
  await page.getByRole('button', { name: 'Novo cadastro' }).click();
  drawer = page.getByRole('dialog');
  await drawer.locator('#sup-name').fill(partnerName);
  await drawer.locator('#sup-doc').fill(`88${runId.slice(-12)}`.padEnd(14, '7'));
  await drawer.locator('#sup-discount-type').selectOption('percentual');
  await drawer.locator('#sup-discount-value').fill('8');
  await drawer.locator('#sup-payment-method').fill('boleto');
  await drawer.locator('#sup-terms').fill('30 dias');
  await drawer.locator('#sup-commercial-notes').fill('Snapshot E2E');
  await drawer.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText(partnerName).first()).toBeVisible();

  // Cliente: o servico de referencia faz somente seu campo aparecer como obrigatorio.
  await goTo(page, 'clients');
  await page.getByRole('button', { name: 'Novo Cliente' }).click();
  const clientDialog = page.getByRole('dialog');
  await clientDialog.locator('#client-service-context').selectOption({ label: serviceName });
  await clientDialog.locator('#client-name').fill(clientName);
  await clientDialog.locator(`#client-extra-${fieldKey}`).fill('REG123456');
  await clientDialog.getByRole('button', { name: 'Criar cliente' }).click();
  await expect(page.getByText(clientName).first()).toBeVisible();

  // Pedido preserva o cliente atendido e registra o parceiro como contratante.
  await goTo(page, 'pedidos');
  await page.getByRole('button', { name: 'Novo pedido' }).click();
  drawer = page.getByRole('dialog');
  await drawer.locator('#no-client').fill(clientName);
  await drawer.getByRole('option', { name: new RegExp(clientName) }).click();
  await drawer.locator('#no-contractor').selectOption('partner');
  await drawer.locator('#no-partner').selectOption({ label: partnerName });
  await expect(drawer.locator('.sisv-summary-box').getByText('8%')).toBeVisible();
  await expect(drawer.getByText('30 dias')).toBeVisible();
  await drawer.getByRole('button', { name: 'Criar pedido' }).click();

  drawer = page.getByRole('dialog');
  const serviceOption = drawer.locator('#oi-add option').filter({ hasText: serviceName });
  await drawer.locator('#oi-add').selectOption(await serviceOption.getAttribute('value'));
  await drawer.getByRole('button', { name: 'Adicionar item' }).click();
  await expect(drawer.locator('.sisv-table tbody').getByText(serviceName)).toBeVisible();
  await drawer.getByRole('tab').filter({ hasText: /Revis/i }).click();
  await expect(drawer.getByText(/Dados obrigat.+rios do cliente completos/)).toBeVisible();
  await expect(drawer.getByText(new RegExp(`Contratante: ${partnerName}`))).toBeVisible();

  // Confere o contrato persistido, nao apenas o texto da tela.
  const orderId = new URL(page.url()).searchParams.get('pedido');
  expect(orderId).toBeTruthy();
  const response = await page.request.get(`/api/orders/${orderId}`);
  expect(response.ok()).toBeTruthy();
  const order = (await response.json()).data;
  expect(order.client_name).toBe(clientName);
  expect(order.contractor_partner_name).toBe(partnerName);
  expect(Number(order.applied_commercial_terms.discount_value)).toBe(8);
  expect(order.applied_commercial_terms.payment_terms).toBe('30 dias');
  expect(order.client_field_validation.valid).toBe(true);
});
