const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: {
    // 15s (era 10s): a suíte roda contra o Next em modo dev e um banco em
    // memória compartilhado, que ficam mais lentos conforme a execução avança.
    // Com 10s, asserções corretas falhavam de forma intermitente no fim da
    // suíte completa, embora cada spec passasse isolado. Uma asserção realmente
    // quebrada continua reprovando — apenas 5s depois.
    timeout: 15_000,
    // Tolerancia minima na regressao visual: a largura do texto mascarado
    // (datas) varia 1px entre execucoes e pintava a borda da mascara como
    // diferenca. 100px em 1440x900 e 0,008% da imagem — qualquer mudanca real
    // de layout ou conteudo move muito mais que isso e continua reprovando.
    toHaveScreenshot: { maxDiffPixels: 100 },
  },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3001',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node backend/sisv-demo-server.js',
      url: 'http://127.0.0.1:5000/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:3001/login',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
