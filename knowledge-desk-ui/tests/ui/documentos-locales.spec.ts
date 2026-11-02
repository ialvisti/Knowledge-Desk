import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { simularServidor } from './fixtures'

// Solo se sustituye la API de capacidades del servidor. La extracción, los
// archivos, las transacciones de IndexedDB y la búsqueda del navegador son reales.
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const V1 = 'Política ficticia de viáticos\r\nEl reembolso diario de viáticos es de 120000 COP.\r\nLa solicitud se presenta dentro de 15 días.\r\n'
const V2 = 'Política ficticia de viáticos\r\nEl reembolso diario de viáticos es de 180000 COP.\r\nLa solicitud se presenta dentro de 10 días.\r\n'
const NOMBRE = 'Politica_viaticos_v1.txt'
const NUEVO = 'Politica_viaticos_v2.txt'
const txt = (name: string, texto: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(texto, 'utf8') })
const fila = (page: Page, nombre: string) => page.locator('tbody tr').filter({ has: page.getByRole('link', { name: nombre, exact: true }) })

async function preparar(page: Page) {
  const peticionesProhibidas: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if ((url.pathname.startsWith('/api/documentos') && request.method() !== 'GET') || url.pathname === '/api/consulta') {
      peticionesProhibidas.push(`${request.method()} ${url.pathname}`)
    }
  })
  await simularServidor(page, {
    estado: { indexacion: { configurada: false, destino: null }, datosTemporales: true, accesoPublico: true },
    indexacion: false,
  })
  await page.goto('/documentos')
  await expect(page.getByLabel('Seleccionar documentos locales')).toBeAttached()
  return peticionesProhibidas
}

async function cargar(page: Page, nombre = NOMBRE, contenido = V1) {
  await page.getByLabel('Seleccionar documentos locales').setInputFiles(txt(nombre, contenido))
  await expect(fila(page, nombre)).toContainText('Indexado')
}

async function abrirReemplazo(page: Page) {
  await page.getByRole('button', { name: `Editar ${NOMBRE}`, exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'Reemplazar documento local', exact: true })
  await expect(modal).toBeVisible()
  await page.getByLabel('Seleccionar reemplazo local').setInputFiles(txt(NUEVO, V2))
  await expect(modal.getByRole('button', { name: 'Reemplazar documento', exact: true })).toBeDisabled()
  await modal.getByRole('checkbox').check()
  return modal
}

async function buscar(page: Page, pregunta = 'viáticos') {
  await page.goto('/consulta-local')
  await page.getByRole('textbox', { name: 'Pregunta sobre tus documentos locales' }).fill(pregunta)
  await page.getByRole('button', { name: 'Buscar en documentos', exact: true }).click()
}

async function bloquearEscrituras(page: Page) {
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction
    const ventana = window as typeof window & { restaurarTransacciones?: () => void }
    ventana.restaurarTransacciones = () => { IDBDatabase.prototype.transaction = original }
    IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
      if (args[1] === 'readwrite') throw new DOMException('Fallo de cuota controlado para la prueba.', 'QuotaExceededError')
      return Reflect.apply(original, this, args)
    }
  })
}

async function restaurarEscrituras(page: Page) {
  await page.evaluate(() => {
    const ventana = window as typeof window & { restaurarTransacciones?: () => void }
    ventana.restaurarTransacciones?.()
    delete ventana.restaurarTransacciones
  })
}

test.describe('HU07–HU09 · colección local con IndexedDB real', () => {
  test('carga, persiste al recargar y descarga los bytes originales sin enviar el archivo al servidor', async ({ page }) => {
    const peticiones = await preparar(page)
    await cargar(page)
    await expect(page.getByRole('main')).not.toContainText(/Indexado local/i)
    await expect(page.locator('.status-local')).toHaveCount(0)
    const href = await fila(page, NOMBRE).getByRole('link', { name: NOMBRE }).getAttribute('href')
    expect(href).toMatch(/^\/documentos\/local\//)
    await page.reload()
    await expect(fila(page, NOMBRE)).toContainText('Indexado')
    await fila(page, NOMBRE).getByRole('link', { name: NOMBRE }).click()
    await expect(page.getByRole('main')).toContainText('120000 COP')
    const descargaPendiente = page.waitForEvent('download')
    await page.getByRole('link', { name: 'Descargar original', exact: true }).click()
    const descarga = await descargaPendiente
    expect(descarga.suggestedFilename()).toBe(NOMBRE)
    const archivo = await descarga.path()
    expect(archivo).not.toBeNull()
    expect(await readFile(archivo!)).toEqual(Buffer.from(V1, 'utf8'))
    expect(peticiones).toEqual([])
  })

  test('reemplazo total confirmado: conserva identidad y las consultas usan solo el contenido nuevo', async ({ page }) => {
    const peticiones = await preparar(page)
    await cargar(page)
    const href = await fila(page, NOMBRE).getByRole('link', { name: NOMBRE }).getAttribute('href')
    await buscar(page)
    await expect(page.getByRole('main')).toContainText('120000 COP')
    await page.goto('/documentos')
    const modal = await abrirReemplazo(page)
    await modal.getByRole('button', { name: 'Reemplazar documento', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Documento reemplazado', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Volver a documentos', exact: true }).click()
    await expect(fila(page, NUEVO).getByRole('link', { name: NUEVO })).toHaveAttribute('href', href!)
    await expect(fila(page, NOMBRE)).toHaveCount(0)
    await page.reload()
    await expect(fila(page, NUEVO)).toContainText('Indexado')
    await buscar(page)
    await expect(page.getByRole('main')).toContainText('180000 COP')
    await expect(page.getByRole('main')).not.toContainText('120000 COP')
    expect(peticiones).toEqual([])
  })

  test('elimina con confirmación, conserva registro técnico y retira también los fragmentos de búsqueda', async ({ page }) => {
    const peticiones = await preparar(page)
    await cargar(page)
    await page.getByRole('button', { name: `Eliminar ${NOMBRE}`, exact: true }).click()
    const modal = page.getByRole('dialog', { name: '¿Eliminar este documento local?', exact: true })
    await expect(modal.getByRole('button', { name: 'Eliminar documento', exact: true })).toBeDisabled()
    await modal.getByRole('checkbox').check()
    await modal.getByRole('button', { name: 'Eliminar documento', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Documento eliminado', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog')).toContainText('Registro técnico')
    await page.getByRole('button', { name: 'Volver a documentos', exact: true }).click()
    await expect(fila(page, NOMBRE)).toHaveCount(0)
    await page.reload()
    await expect(fila(page, NOMBRE)).toHaveCount(0)
    await buscar(page)
    await expect(page.getByRole('main')).not.toContainText('120000 COP')
    await expect(page.getByRole('main').getByRole('link', { name: NOMBRE, exact: true })).toHaveCount(0)
    expect(peticiones).toEqual([])
  })

  test('una transacción fallida al reemplazar conserva íntegra la versión anterior y permite intentarlo de nuevo', async ({ page }) => {
    await preparar(page)
    await cargar(page)
    const modal = await abrirReemplazo(page)
    await bloquearEscrituras(page)
    await modal.getByRole('button', { name: 'Reemplazar documento', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'No se pudo reemplazar el documento', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog')).toContainText(/cuota|espacio|almacenamiento/i)
    await restaurarEscrituras(page)
    await page.goto('/documentos')
    await expect(fila(page, NOMBRE)).toContainText('Indexado')
    await expect(fila(page, NUEVO)).toHaveCount(0)
    await buscar(page)
    await expect(page.getByRole('main')).toContainText('120000 COP')
    await expect(page.getByRole('main')).not.toContainText('180000 COP')
    await page.goto('/documentos')
    const reintento = await abrirReemplazo(page)
    await reintento.getByRole('button', { name: 'Reemplazar documento', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Documento reemplazado', exact: true })).toBeVisible()
  })

  test('un borrado fallido no anuncia éxito ni retira la versión activa', async ({ page }) => {
    await preparar(page)
    await cargar(page)
    await page.getByRole('button', { name: `Eliminar ${NOMBRE}`, exact: true }).click()
    const modal = page.getByRole('dialog', { name: '¿Eliminar este documento local?', exact: true })
    await modal.getByRole('checkbox').check()
    await bloquearEscrituras(page)
    await modal.getByRole('button', { name: 'Eliminar documento', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText(/cuota|espacio|almacenamiento/i)
    await expect(page.getByRole('heading', { name: 'Documento eliminado', exact: true })).toHaveCount(0)
    await restaurarEscrituras(page)
    await page.goto('/documentos')
    await expect(fila(page, NOMBRE)).toContainText('Indexado')
    await buscar(page)
    await expect(page.getByRole('main')).toContainText('120000 COP')
  })

  test('rechaza extensión, archivo vacío y texto sin contenido sin publicar documentos', async ({ page }) => {
    await preparar(page)
    const selector = page.getByLabel('Seleccionar documentos locales')
    for (const archivo of [
      { name: 'programa.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('archivo ficticio') },
      txt('vacio.txt', ''),
      txt('espacios.txt', '  \r\n\t  '),
      { name: 'ilegible.pdf', mimeType: 'application/pdf', buffer: Buffer.from('Esto no es un PDF.') },
      { name: 'ilegible.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('Esto no es un DOCX.') },
    ]) {
      await selector.setInputFiles(archivo)
      await expect(page.getByRole('alert').last()).toBeVisible()
      await expect(page.locator('tbody tr')).toHaveCount(0)
    }
  })

  test('rechaza más de 50 MB antes de extraer o almacenar', async ({ page }) => {
    await preparar(page)
    await page.getByLabel('Seleccionar documentos locales').evaluate((element: HTMLInputElement) => {
      const transferencia = new DataTransfer()
      transferencia.items.add(new File([new Uint8Array(50 * 1024 * 1024 + 1)], 'demasiado-grande.txt', { type: 'text/plain' }))
      element.files = transferencia.files
      element.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await expect(page.getByRole('alert').last()).toContainText(/50\s?MB/)
    await expect(page.locator('tbody tr')).toHaveCount(0)
  })

  test('la búsqueda no devuelve documentos ajenos a los términos de la pregunta', async ({ page }) => {
    await preparar(page)
    await cargar(page)
    await buscar(page, 'astronomía galáctica telescopio')
    await expect(page.getByRole('main')).not.toContainText('120000 COP')
    await expect(page.getByRole('main').getByRole('link', { name: NOMBRE, exact: true })).toHaveCount(0)
  })

  test('otra pestaña invalida resultados antiguos al reemplazar y eliminar sin recargar la consulta', async ({ page, context }) => {
    await simularServidor(context, {
      estado: { indexacion: { configurada: false, destino: null }, datosTemporales: true, accesoPublico: true },
      indexacion: false,
    })
    await page.goto('/documentos')
    await cargar(page)
    const consulta = await context.newPage()
    await buscar(consulta)
    await expect(consulta.getByRole('main')).toContainText('120000 COP')

    const reemplazo = await abrirReemplazo(page)
    await reemplazo.getByRole('button', { name: 'Reemplazar documento', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Documento reemplazado', exact: true })).toBeVisible()
    await expect(consulta.getByRole('main')).not.toContainText('120000 COP')

    // Reconsultar explícitamente permite que la UI elija limpiar o actualizar
    // resultados al observar la revisión, pero nunca conservar fuentes retiradas.
    await consulta.getByRole('button', { name: 'Buscar en documentos', exact: true }).click()
    await expect(consulta.getByRole('main')).toContainText('180000 COP')
    await page.getByRole('button', { name: 'Volver a documentos', exact: true }).click()
    await page.getByRole('button', { name: `Eliminar ${NUEVO}`, exact: true }).click()
    const eliminacion = page.getByRole('dialog', { name: '¿Eliminar este documento local?', exact: true })
    await eliminacion.getByRole('checkbox').check()
    await eliminacion.getByRole('button', { name: 'Eliminar documento', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Documento eliminado', exact: true })).toBeVisible()
    await expect(consulta.getByRole('main')).not.toContainText('180000 COP')
  })

  // Estas muestras son ficticias; prueban los parsers reales y su worker local.
  for (const extension of ['pdf', 'docx'] as const) {
    test(`extrae texto útil de un archivo ${extension.toUpperCase()} real y lo conserva tras recarga`, async ({ page }) => {
      await preparar(page)
      const nombre = `politica-viaticos-v1.${extension}`
      await page.getByLabel('Seleccionar documentos locales').setInputFiles(path.join(RAIZ, 'demo', 'documentos-locales', nombre))
      await expect(fila(page, nombre)).toContainText('Indexado')
      await page.reload()
      await fila(page, nombre).getByRole('link', { name: nombre }).click()
      await expect(page.getByRole('main')).toContainText('120000')
    })
  }
})
