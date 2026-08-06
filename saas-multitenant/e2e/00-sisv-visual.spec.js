const { test, expect } = require('@playwright/test');

async function login(page) {
  await page.goto('/login');
  await page.locator('input[name="username"]').fill('gestor.sinalverde');
  await page.locator('input[type="password"]').fill('senha-demo');
  await page.getByRole('button', { name: /Entrar/ }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 45_000 });
  await expect(page.getByRole('navigation', { name: /Navega/ })).toBeVisible();
}

test.describe.serial('SISV · regressão visual TELUN', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('login institucional desktop e mobile', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/login');
    await expect(page.getByText('SISV', { exact: true })).toBeVisible();
    await expect(page.getByText('Sistema Integrado da Sinal Verde')).toBeVisible();
    await expect(page.getByText('Uma solução', { exact: true }).first()).toBeVisible();
    await expect(page).toHaveScreenshot('telun-login-desktop.png', {
      animations: 'disabled',
      caret: 'hide',
      fullPage: true,
    });

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
      cosmic: '#0B0B12',
      violet: '#3B1F6A',
      lilac: '#A56FFF',
      copper: '#FF6A3D',
      sand: '#FFD8A6',
    });
    const submitContrast = await page.locator('.telun-login-submit').evaluate((element) => {
      const style = getComputedStyle(element);
      const rgb = (value) => value.match(/\d+/g).slice(0, 3).map(Number);
      const luminance = (value) => {
        const channels = rgb(value).map((channel) => {
          const normalized = channel / 255;
          return normalized <= .03928 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
        });
        return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
      };
      const a = luminance(style.backgroundColor);
      const b = luminance(style.color);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    });
    expect(submitContrast).toBeGreaterThanOrEqual(4.5);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('body')).toHaveScreenshot('telun-login-mobile-390.png', {
      animations: 'disabled',
      caret: 'hide',
    });
    for (const viewport of [
      { width: 320, height: 700 },
      { width: 360, height: 800 },
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
    ]) {
      await page.setViewportSize(viewport);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
      await expect(page.locator('.telun-login-card')).toBeInViewport();
    }
  });

  test('shell, dashboard, sidebar e Central de Atenção', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    // O dashboard passou a carregar também as seções comerciais (SISV 2.0), que
    // chegam por uma segunda requisição. Sem esperar por elas, a captura pega a
    // página a meio caminho e a comparação falha de forma intermitente.
    await expect(page.getByRole('heading', { name: 'Visão comercial e financeira' })).toBeVisible();
    await expect(page.locator('.sisv-exec-section').last()).toBeVisible();
    await expect(page).toHaveScreenshot('telun-dashboard-desktop.png', {
      animations: 'disabled',
      caret: 'hide',
      mask: [page.locator('input[type="date"]')],
    });

    await page.getByRole('button', { name: 'Recolher menu' }).click();
    await expect(page.locator('.sidebar')).toHaveClass(/sidebar-collapsed/);
    await expect(page).toHaveScreenshot('telun-sidebar-collapsed.png', {
      animations: 'disabled',
      caret: 'hide',
      mask: [page.locator('input[type="date"]')],
    });

    await page.getByRole('button', { name: 'Expandir menu' }).click();
    await page.getByRole('button', { name: /Central de Atenção/ }).click();
    await expect(page.getByRole('heading', { name: 'Central de Atenção' })).toBeVisible();
    await expect(page).toHaveScreenshot('telun-central-atencao.png', {
      animations: 'disabled',
      caret: 'hide',
    });
  });

  test('fila, detalhe, relatório e operação mobile', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.getByRole('button', { name: 'Processos', exact: true }).click();
    await expect(page.locator('.data-table tbody tr').first()).toBeVisible();
    await expect(page).toHaveScreenshot('telun-processos-fila.png', {
      animations: 'disabled',
      caret: 'hide',
      mask: [page.locator('input[type="date"]'), page.getByText(/\d{2}\/\d{2}\/\d{4}/)],
    });

    await page.locator('.data-table tbody tr').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page).toHaveScreenshot('telun-processo-drawer.png', {
      animations: 'disabled',
      caret: 'hide',
      mask: [page.getByText(/\d{2}\/\d{2}\/\d{4}/)],
    });
    await page.getByLabel(/Fechar painel/).click();

    await page.getByRole('button', { name: 'Relatórios' }).click();
    await page.getByRole('button', { name: 'Gerar relatório' }).click();
    await expect(page.locator('.sisv-report-header')).toBeVisible();
    await expect(page).toHaveScreenshot('telun-relatorio.png', {
      animations: 'disabled',
      caret: 'hide',
      mask: [page.locator('input[type="date"]'), page.locator('.sisv-report-header dl')],
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Abrir menu' }).click();
    await page.getByRole('button', { name: 'Meu Trabalho' }).click();
    await expect(page.getByRole('heading', { name: 'Meu Trabalho' })).toBeVisible();
    await expect(page.locator('body')).toHaveScreenshot('telun-meu-trabalho-mobile-390.png', {
      animations: 'disabled',
      caret: 'hide',
      mask: [page.getByText(/\d{2}\/\d{2}\/\d{4}/)],
    });
    for (const viewport of [
      { width: 320, height: 700 },
      { width: 360, height: 800 },
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    }
  });
});
