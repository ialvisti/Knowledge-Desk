import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { simularServidor } from '../ui/fixtures'

// Evidencia del motor real del navegador: solo /api/estado se presenta con las
// capacidades de Render (sin índice de escritura). Archivos sintéticos locales.
// La captura 06 reproduce un fallo de cuota inyectado de forma controlada;
// ninguna captura pretende acreditar escritura en ForUsGuide ni embeddings.
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SALIDA = path.join(RAIZ, 'docs', 'verificacion', 'documentos-locales')
const DEMO = path.join(RAIZ, 'demo', 'documentos-locales')
const NOMBRE = 'politica-viaticos-v1.pdf'
const NUEVO = 'politica-viaticos-v2.docx'

test.setTimeout(120_000)

async function captura(page: Page, nombre: string) {
  await page.evaluate(() => document.fonts.ready)
  const modalVisible = await page.getByRole('dialog').isVisible()
  await page.screenshot({ path: path.join(SALIDA, nombre), fullPage: !modalVisible, animations: 'disabled' })
}

async function buscar(page: Page) {
  await page.goto('/consulta-local')
  await page.getByRole('textbox', { name: 'Pregunta sobre tus documentos locales' }).fill('¿Cuál es el auxilio diario de viáticos y en qué plazo deben legalizarse?')
  await page.getByRole('button', { name: 'Buscar en documentos', exact: true }).click()
}

test('capturas de carga, reemplazo, fallo controlado y eliminación en IndexedDB real', async ({ page }) => {
  mkdirSync(SALIDA, { recursive: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await simularServidor(page, {
    estado: { indexacion: { configurada: false, destino: null }, datosTemporales: true, accesoPublico: true },
    indexacion: false,
  })
  await page.goto('/documentos')
  await page.getByLabel('Seleccionar documentos locales').setInputFiles(path.join(DEMO, NOMBRE))
  await expect(page.locator('tbody tr').filter({ hasText: NOMBRE })).toContainText('Indexado')
  await page.reload()
  await expect(page.locator('tbody tr').filter({ hasText: NOMBRE })).toContainText('Indexado')
  await expect(page.getByRole('main')).not.toContainText(/Indexado local/i)
  await expect(page.locator('.status-local')).toHaveCount(0)
  await captura(page, '01-documento-cargado-persistido.png')

  await page.getByRole('link', { name: NOMBRE, exact: true }).click()
  await expect(page.getByRole('main')).toContainText('120000')
  await captura(page, '02-texto-extraido-original.png')

  await page.goto('/documentos')
  await page.getByRole('button', { name: `Editar ${NOMBRE}`, exact: true }).click()
  await page.getByLabel('Seleccionar reemplazo local').setInputFiles(path.join(DEMO, NUEVO))
  let modal = page.getByRole('dialog', { name: 'Reemplazar documento local', exact: true })
  await modal.getByRole('checkbox').check()
  await captura(page, '03-reemplazar-documento-dialogo.png')
  await modal.getByRole('button', { name: 'Reemplazar documento', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Documento reemplazado', exact: true })).toBeVisible()
  await captura(page, '04-documento-reemplazado.png')
  await page.getByRole('button', { name: 'Volver a documentos', exact: true }).click()
  await buscar(page)
  await expect(page.getByRole('main')).toContainText('180000')
  await expect(page.getByRole('main')).not.toContainText('120000')
  await captura(page, '05-consulta-version-nueva.png')

  await page.goto('/documentos')
  await page.getByRole('button', { name: `Editar ${NUEVO}`, exact: true }).click()
  await page.getByLabel('Seleccionar reemplazo local').setInputFiles(path.join(DEMO, NOMBRE))
  modal = page.getByRole('dialog', { name: 'Reemplazar documento local', exact: true })
  await modal.getByRole('checkbox').check()
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction
    const ventana = window as typeof window & { restaurarTransacciones?: () => void }
    ventana.restaurarTransacciones = () => { IDBDatabase.prototype.transaction = original }
    IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
      if (args[1] === 'readwrite') throw new DOMException('Fallo de cuota controlado para la prueba.', 'QuotaExceededError')
      return Reflect.apply(original, this, args)
    }
  })
  await modal.getByRole('button', { name: 'Reemplazar documento', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'No se pudo reemplazar el documento', exact: true })).toBeVisible()
  await captura(page, '06-error-cuota-controlado.png')
  await page.evaluate(() => {
    const ventana = window as typeof window & { restaurarTransacciones?: () => void }
    ventana.restaurarTransacciones?.()
    delete ventana.restaurarTransacciones
  })
  await page.goto('/documentos')
  await expect(page.getByRole('link', { name: NUEVO, exact: true })).toBeVisible()
  await page.setViewportSize({ width: 375, height: 812 })
  await captura(page, '07-movil-documentos.png')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: `Eliminar ${NUEVO}`, exact: true }).click()
  modal = page.getByRole('dialog', { name: '¿Eliminar este documento local?', exact: true })
  await modal.getByRole('checkbox').check()
  await captura(page, '08-eliminar-documento-confirmacion.png')
  await modal.getByRole('button', { name: 'Eliminar documento', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Documento eliminado', exact: true })).toBeVisible()
  await captura(page, '09-documento-eliminado.png')
  await page.getByRole('button', { name: 'Volver a documentos', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(0)
  await buscar(page)
  await expect(page.getByRole('main')).not.toContainText('180000')
  await captura(page, '10-consulta-sin-documento-eliminado.png')

  writeFileSync(path.join(SALIDA, 'procedencia.json'), JSON.stringify({
    generadoEn: new Date().toISOString(),
    almacenamiento: 'IndexedDB real del navegador; extracción PDF y DOCX real; búsqueda local por términos.',
    servidor: 'API de capacidades sustituida dentro de Playwright: modo ForUsGuide sin indexación, equivalente a Render. No se muta el índice remoto.',
    archivos: [NOMBRE, NUEVO],
    datos: 'Ficticios, creados para demostración de clase.',
    falloControlado: { captura: '06-error-cuota-controlado.png', metodo: 'IDBDatabase.prototype.transaction lanza QuotaExceededError solo en readwrite. Se restaura antes de la siguiente operación.' },
    comando: 'npx playwright test tests/capturas/documentos-locales.spec.ts --project=capturas',
  }, null, 2) + '\n', 'utf8')
})
