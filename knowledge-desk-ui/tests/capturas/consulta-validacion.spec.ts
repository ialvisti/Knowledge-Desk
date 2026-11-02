import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { contratoCasoVacaciones, errorContrato, FRASE_VACACIONES, PREGUNTA_REPORTADA, simularServidor } from '../ui/fixtures'

// Evidencia visual de la validación de la pregunta y del caso reportado. La API
// se sustituye dentro del navegador con los contratos que verifica
// knowledge-desk-server/test/consulta-validacion.test.ts; no se llama a ForUsGuide.
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SALIDA = path.join(RAIZ, 'docs', 'verificacion', 'consulta-validacion')
const resultados = (pregunta: string) => `/resultados?${new URLSearchParams({ q: pregunta })}`

async function captura(page: Page, nombre: string) {
  await page.screenshot({ path: path.join(SALIDA, nombre), fullPage: true, animations: 'disabled' })
}

test('capturas de la validación de la pregunta y del caso reportado', async ({ page }) => {
  mkdirSync(SALIDA, { recursive: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  let respuesta: () => { status: number; body: unknown } = () => ({ status: 200, body: contratoCasoVacaciones })
  const registro = await simularServidor(page, { consulta: () => respuesta() })

  await page.goto(resultados('hola'))
  await expect(page.getByText('Sin ID de soporte: la solicitud no se envió.')).toBeVisible()
  await captura(page, '01-url-pregunta-corta.png')

  await page.goto('/')
  await page.getByLabel('Escribe tu consulta').fill('x'.repeat(150))
  await page.getByRole('button', { name: 'Buscar', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('150 caracteres')
  await captura(page, '02-formulario-texto-largo-sin-recorte.png')

  await page.goto(resultados(FRASE_VACACIONES))
  await expect(page.getByRole('heading', { name: 'Asistente de documentación interna' })).toBeVisible()
  await captura(page, '03-caso-reportado-insuficiente.png')

  respuesta = () => errorContrato('UPSTREAM_AUTH_ERROR', 'El servicio de consulta rechazó la credencial del servidor. Avisa al administrador.', 'req-7c0a9e15', 502, { retryable: false, upstream_status: 401 })
  await page.goto(resultados(FRASE_VACACIONES))
  await expect(page.getByRole('heading', { name: 'El servicio de consulta rechazó la configuración' })).toBeVisible()
  await captura(page, '04-error-http-401-forusguide.png')

  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(resultados(PREGUNTA_REPORTADA))
  await expect(page.getByText('Sin ID de soporte: la solicitud no se envió.')).toBeVisible()
  await captura(page, '05-movil-url-pregunta-reportada.png')

  // Solo las dos consultas válidas (caso reportado y error 401) llegaron a la API.
  expect(registro.consultas).toHaveLength(2)
  writeFileSync(path.join(SALIDA, 'procedencia.json'), JSON.stringify({
    generadoEn: new Date().toISOString(),
    metodo: 'Playwright con la API sustituida en el navegador (tests/ui/fixtures.ts). Los contratos coinciden con los que produce el servidor en knowledge-desk-server/test/consulta-validacion.test.ts.',
    servicioExterno: 'No se llama a ForUsGuide ni a ningún modelo.',
    comando: 'npx playwright test tests/capturas/consulta-validacion.spec.ts --project=capturas',
  }, null, 2) + '\n', 'utf8')
})
