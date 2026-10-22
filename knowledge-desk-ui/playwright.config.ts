import { defineConfig } from '@playwright/test'

// Puertos propios de las pruebas: no chocan con una demo abierta (8788/5173).
export const PUERTOS = { ui: 5174, servidor: 8789, pinecone: 8792, forusguide: 8793 }

export default defineConfig({
  testDir: './tests',
  reporter: 'list',
  workers: 2,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${PUERTOS.ui}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    // Estados de la interfaz con el servidor sustituido en el navegador (fixtures explícitas).
    { name: 'escritorio', testDir: './tests/ui', fullyParallel: true, use: { viewport: { width: 1280, height: 1024 } } },
    { name: 'movil', testDir: './tests/ui', fullyParallel: true, use: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } },
    // Flujo completo contra el servidor real en modo simulado (pipeline documental real).
    { name: 'e2e', testDir: './tests/e2e', fullyParallel: false, workers: 1, use: { viewport: { width: 1440, height: 1000 } } },
    // Capturas de verificación visual a los tamaños de las referencias.
    { name: 'capturas', testDir: './tests/capturas', fullyParallel: false, workers: 1 },
  ],
  webServer: [
    {
      command: 'node ../knowledge-desk-server/test/support/simulated-stack.ts',
      url: `http://127.0.0.1:${PUERTOS.servidor}/api/salud`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        KD_SIM_PORT: String(PUERTOS.servidor),
        KD_SIM_PINECONE_PORT: String(PUERTOS.pinecone),
        KD_SIM_FORUSGUIDE_PORT: String(PUERTOS.forusguide),
        KD_VERIFICACION_INDICE_MS: '20000',
      },
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${PUERTOS.ui} --strictPort`,
      url: `http://127.0.0.1:${PUERTOS.ui}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { KD_SERVER_URL: `http://127.0.0.1:${PUERTOS.servidor}` },
    },
  ],
})
