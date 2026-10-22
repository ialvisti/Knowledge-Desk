import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { PUERTOS } from '../../playwright.config'

// Capturas finales de verificación visual, a los tamaños de las referencias de
// docs/negocio/IMAGENES. Se toman contra el servidor REAL en modo simulado: los
// estados de los documentos (Indexado, Procesando, Error), los conteos y las
// fechas son los reales del pipeline en este equipo, no copias de la referencia.
test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const RAIZ = path.resolve(UI, '..')
const SALIDA = path.join(RAIZ, 'docs', 'verificacion')
const DEMO = path.join(RAIZ, 'demo', 'documentos')
const KD = `http://127.0.0.1:${PUERTOS.servidor}`
const PREGUNTA = '¿Cuál es el procedimiento para reembolso de viáticos internacionales?'
const resultados = (pregunta: string) => `/resultados?${new URLSearchParams({ q: pregunta })}`
const tomadas: { archivo: string; referencia: string | null; nota: string }[] = []

async function captura(objetivo: Page | Locator, archivo: string, referencia: string | null, nota: string, completa = false) {
  const opciones = { path: path.join(SALIDA, archivo), animations: 'disabled' as const }
  if ('goto' in objetivo) await objetivo.screenshot({ ...opciones, fullPage: completa })
  else await objetivo.screenshot(opciones)
  tomadas.push({ archivo, referencia, nota })
}

async function control(servicio: 'pinecone' | 'forusguide', datos: Record<string, unknown>) {
  const respuesta = await fetch(`http://127.0.0.1:${PUERTOS[servicio]}/__control`, { method: 'POST', body: JSON.stringify(datos) })
  expect(respuesta.ok).toBe(true)
}

async function subir(nombre: string) {
  const datos = new FormData()
  datos.append('archivo', new Blob([readFileSync(path.join(DEMO, nombre))], { type: 'application/json' }), nombre)
  const respuesta = await fetch(`${KD}/api/documentos`, { method: 'POST', body: datos })
  expect(respuesta.status, nombre).toBe(202)
  return (await respuesta.json() as { documento: { id: string } }).documento.id
}

async function estadoDe(id: string) {
  const { documentos } = await (await fetch(`${KD}/api/documentos`)).json() as { documentos: { id: string; estado: string }[] }
  return documentos.find(doc => doc.id === id)?.estado
}

async function esperar(id: string, estados: string[]) {
  await expect.poll(() => estadoDe(id), { timeout: 60_000, intervals: [250] }).toMatch(new RegExp(`^(${estados.join('|')})$`))
}

async function vista(page: Page, ancho: number, alto: number) {
  await page.setViewportSize({ width: ancho, height: alto })
}

// Lo que vería la persona: sin el cursor de texto parpadeando en las capturas.
async function sinCursor(page: Page) {
  await page.addStyleTag({ content: '* { caret-color: transparent !important; }' })
}

test.beforeAll(async () => {
  mkdirSync(SALIDA, { recursive: true })
  // Escribe los artículos JSON sintéticos de demo (demo/documentos, fuera de Git).
  execFileSync(process.execPath, [path.join(RAIZ, 'knowledge-desk-server', 'test', 'support', 'simulated-stack.ts'), '--documentos'], { stdio: 'ignore' })

  // Orden de la referencia "Vista de documentos". Manual_Operaciones_V2 falla
  // primero de verdad (el índice rechaza su escritura) para poder reintentarlo
  // y capturarlo mientras se procesa.
  await esperar(await subir('Política_Privacidad_2023.json'), ['indexado'])
  await control('pinecone', { upsertFalla: 'kd_doc0002_' })
  await esperar(await subir('Manual_Operaciones_V2.json'), ['error'])
  await control('pinecone', { upsertFalla: null })
  for (const nombre of ['Guia_Estilo_Archivistica.json', 'Reporte_Financiero_Q3.json']) await esperar(await subir(nombre), ['indexado'])
  await esperar(await subir('Borrador_Incompleto.json'), ['error'])

  // Un artículo del corpus EXTERNO (ForUsGuide), sintético, para la vista de
  // fuente externa: se escribe en el índice simulado con su API de upsert.
  const registros = [
    { _id: 'rollover_externo_chunk_1', content: '# Step-by-Step Procedure\n\n## Step 1: Confirma con el proveedor receptor cómo recibe el rollover.', article_id: 'rollover_externo', article_title: 'Rollover directo de un plan 401(k) (externo, sintético)', chunk_type: 'steps', chunk_index: 1, chunk_tier: 'high', chunk_category: 'steps_1_to_1' },
    { _id: 'rollover_externo_chunk_2', content: '# Frequently Asked Questions\n\n## Q: ¿Se puede pagar por ACH?\n**A:** No para un rollover directo.', article_id: 'rollover_externo', article_title: 'Rollover directo de un plan 401(k) (externo, sintético)', chunk_type: 'faqs', chunk_index: 2, chunk_tier: 'low', chunk_category: 'group_1' },
  ]
  const upsert = await fetch(`http://127.0.0.1:${PUERTOS.pinecone}/records/namespaces/kb_simulado/upsert`, { method: 'POST', body: registros.map(registro => JSON.stringify(registro)).join('\n') })
  expect(upsert.status).toBe(201)
})

test.afterAll(() => {
  const filas = tomadas.map(item => `<tr><td><strong>${item.archivo}</strong><br><span>${item.nota}</span></td>
<td><a href="${item.archivo}"><img src="${item.archivo}" alt="${item.archivo}"></a></td>
<td>${item.referencia ? `<a href="../negocio/IMAGENES/${encodeURI(item.referencia)}"><img src="../negocio/IMAGENES/${encodeURI(item.referencia)}" alt="${item.referencia}"></a><br><span>${item.referencia}</span>` : '<span>Sin referencia: pantalla ampliada</span>'}</td></tr>`).join('\n')
  writeFileSync(path.join(SALIDA, 'comparacion.html'), `<!doctype html><html lang="es"><meta charset="utf-8"><title>Knowledge Desk · capturas frente a referencias</title>
<style>body{font:14px/1.4 system-ui;margin:24px;color:#1f2937}table{border-collapse:collapse;width:100%}td{vertical-align:top;border-top:1px solid #ddd;padding:12px}img{max-width:560px;border:1px solid #ccc}span{color:#555}</style>
<h1>Capturas finales (modo simulado) frente a las referencias</h1>
<p>Servidor real de Knowledge Desk con índice y servicio de consulta simulados en este equipo. Conteos, fechas e IDs son los reales del pipeline; no se copian de las referencias.</p>
<table><thead><tr><th>Captura</th><th>Knowledge Desk</th><th>Referencia</th></tr></thead><tbody>
${filas}
</tbody></table></html>\n`, 'utf8')
})

test('Documentos con estados reales (HU07)', async ({ page }) => {
  // Primero, con los cinco artículos de la referencia y nada más.
  // Manual_Operaciones_V2 se reintenta con el índice tardando en confirmar la
  // escritura: queda Procesando de verdad mientras se toma la captura.
  await control('pinecone', { retrasoVisibilidadMs: 12_000 })
  const reintento = await fetch(`${KD}/api/documentos/DOC-0002/reintento`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  expect(reintento.status).toBe(202)
  await expect.poll(async () => (await (await fetch(`http://127.0.0.1:${PUERTOS.pinecone}/__registros`)).json() as { ids: string[] }).ids.some(id => id.startsWith('kd_doc0002_')), { timeout: 15_000 }).toBe(true)
  await control('pinecone', { retrasoVisibilidadMs: 0 })

  await vista(page, 1848, 692)
  await page.goto('/documentos')
  await expect(page.locator('tbody tr').nth(1).getByText('Procesando', { exact: true })).toBeVisible()
  await expect(page.locator('tbody tr').nth(4).getByText('Error', { exact: true })).toBeVisible()
  // V1: geometría de la referencia (1848×692): panel a 208 px, filas de 70 px,
  // cinco filas completas y la zona de carga termina a 584 px.
  const caja = async (selector: string | Locator) => (typeof selector === 'string' ? page.locator(selector).first() : selector).boundingBox()
  const panel = (await caja('.document-table-wrap'))!
  const zona = (await caja('.upload-zone'))!
  const filas = await Promise.all([0, 1, 2, 3, 4].map(indice => caja(page.locator('tbody tr').nth(indice))))
  const geometria = { panelTop: Math.round(panel.y), zonaTop: Math.round(zona.y), zonaBottom: Math.round(zona.y + zona.height), filas: filas.map(fila => Math.round(fila!.height)), quintaBottom: Math.round(filas[4]!.y + filas[4]!.height) }
  writeFileSync(path.join(SALIDA, 'geometria-documentos.json'), `${JSON.stringify({ referencia: { panelTop: 208, zonaTop: 208, zonaBottom: 584, fila: 70, alto: 692 }, medido: geometria }, null, 2)}\n`)
  await captura(page, '10-documentos.png', 'Vista de documentos.png', 'Lista real: Indexado, Procesando (reintento esperando al índice) y Error (sin contenido indexable).')
  expect(Math.abs(geometria.panelTop - 208)).toBeLessThanOrEqual(4)
  expect(Math.abs(geometria.zonaBottom - 584)).toBeLessThanOrEqual(6)
  for (const alto of geometria.filas) expect(Math.abs(alto - 70)).toBeLessThanOrEqual(2)
  expect(geometria.quintaBottom).toBeLessThanOrEqual(692)

  await esperar('DOC-0002', ['indexado'])
  await vista(page, 1280, 900)
  await page.goto('/documentos')
  await page.locator('tbody tr').nth(4).getByRole('button', { name: 'Ver motivo del error' }).click()
  await captura(page.locator('.document-list-section'), '11-documentos-motivo-error.png', null, 'Motivo real del Error de Borrador_Incompleto.json: sin contenido indexable.')

  // El artículo de viáticos sustenta las capturas de consulta, reemplazo y visor.
  await esperar(await subir('Politica_Viaticos_v3.2.json'), ['indexado'])
})

test('Consulta y Resultados (PDF de referencia)', async ({ page }) => {
  await vista(page, 1280, 900)
  await page.goto('/')
  await expect(page.locator('.suggestion-chip').first()).toBeVisible()
  await sinCursor(page)
  await captura(page, '01-consulta.png', 'Consulta — Knowledge Desk.pdf', 'Pantalla inicial con ejemplos verificados contra el corpus y el aviso de modo demostración.', true)

  await page.goto(resultados(PREGUNTA))
  await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible({ timeout: 30_000 })
  await captura(page, '02-resultados.png', 'Resultados — Knowledge Desk.pdf', 'Respuesta sustentada: cobertura, puntos clave y fuentes con su ruta JSON.', true)
})

test('Insuficiencia documental y sin evidencia (HU05)', async ({ page }) => {
  await vista(page, 1366, 768)
  await page.goto(resultados('¿Cómo se legalizan los gastos de un viaje nacional?'))
  await expect(page.locator('.insufficient-card')).toBeVisible({ timeout: 30_000 })
  await sinCursor(page)
  await captura(page, '03-insuficiencia-cobertura-baja.png', 'Mensaje de error en pregunta.png', 'Cobertura baja real: no se genera respuesta.')
  await page.goto(resultados('¿Cuántas semanas de licencia parental corresponden?'))
  await expect(page.locator('.insufficient-card').getByText('Sin evidencia')).toBeVisible({ timeout: 30_000 })
  await captura(page, '04-sin-evidencia.png', 'Mensaje de error en pregunta.png', 'Sin evidencia: sin documentos que ver ni referencias inventadas.')
})

test('Errores diferenciados de la consulta (HU10)', async ({ page }) => {
  await vista(page, 1030, 582)
  await page.goto(resultados('hola'))
  await expect(page.getByRole('heading', { name: 'La pregunta no es válida' })).toBeVisible({ timeout: 30_000 })
  await sinCursor(page)
  await captura(page, '05-error-validacion.png', 'Consumir los servicios de consulta 2.png', 'Validación real del servidor (422) con ID de soporte y contrato JSON.')

  const casos: [string, string, string, number, number, string][] = [
    ['retrieval', 'No pudimos buscar en los documentos', '06-error-recuperacion.png', 1017, 577, 'Consumir los servicios de consulta 3.png'],
    ['vector', 'La base de conocimiento no está disponible', '07-error-base-vectorial.png', 1015, 562, 'Consumir los servicios de consulta 4.png'],
    ['proveedor', 'No pudimos generar la respuesta', '08-error-proveedor.png', 1022, 567, 'Consumir los servicios de consulta 5.png'],
  ]
  for (const [fallo, titulo, archivo, ancho, alto, referencia] of casos) {
    await control('forusguide', { fallo })
    await vista(page, ancho, alto)
    await page.goto(resultados(PREGUNTA))
    await expect(page.getByRole('heading', { name: titulo })).toBeVisible({ timeout: 30_000 })
    await sinCursor(page)
    await captura(page, archivo, referencia, `Fallo "${fallo}" inyectado en el servicio de consulta simulado.`)
  }
  await control('forusguide', { fallo: null, retrasoMs: 32_000 })
  try {
    await vista(page, 1017, 577)
    await page.goto(resultados(PREGUNTA))
    await expect(page.getByRole('heading', { name: 'La consulta tardó demasiado' })).toBeVisible({ timeout: 60_000 })
    await sinCursor(page)
    await captura(page, '09-error-tiempo-agotado.png', null, 'Tiempo máximo del servidor (30 s) agotado: TIMEOUT sin respuesta parcial.')
  } finally {
    await control('forusguide', { retrasoMs: 0 })
  }
})

test('Reemplazo de un artículo (HU08)', async ({ page }) => {
  await vista(page, 1280, 900)
  await page.goto('/documentos')
  // El documento adopta el nombre del archivo de su versión vigente.
  const abrir = async (vigente: string, nuevo: string) => {
    await page.getByRole('button', { name: `Editar ${vigente}` }).click()
    const dialogo = page.getByRole('dialog', { name: 'Reemplazar documento' })
    await dialogo.getByLabel('Seleccionar el nuevo artículo JSON').setInputFiles(path.join(DEMO, nuevo))
    await dialogo.getByRole('checkbox').check()
    return dialogo
  }
  let dialogo = await abrir('Politica_Viaticos_v3.2.json', 'Politica_Viaticos_v3.3.json')
  await captura(dialogo, '12-reemplazo-dialogo.png', 'Vista de edicion de documento.png', 'Diálogo de reemplazo con el título canónico del artículo y su versión activa.')
  await dialogo.getByRole('button', { name: 'Reemplazar documento' }).click()
  const exito = page.getByRole('dialog', { name: 'Documento reemplazado' })
  await expect(exito).toBeVisible({ timeout: 30_000 })
  await captura(exito, '13-reemplazo-exito.png', 'Mensaje de exito de reemplazo de documento.png', 'Reemplazo verificado: la nueva versión ya está activa.')
  await exito.getByRole('button', { name: 'Volver a documentos' }).click()

  await control('pinecone', { upsertFalla: 'kd_doc0006_v1_2' })
  try {
    dialogo = await abrir('Politica_Viaticos_v3.3.json', 'Politica_Viaticos_v3.2.json')
    await dialogo.getByRole('button', { name: 'Reemplazar documento' }).click()
    const error = page.getByRole('dialog', { name: 'No se pudo reemplazar el documento' })
    await expect(error).toBeVisible({ timeout: 30_000 })
    await captura(error, '14-reemplazo-error.png', 'error ar reemplazar archivo.png', 'Fallo real de indexación: se conserva la versión vigente y no se publica la nueva.')
    await error.getByRole('button', { name: 'Cerrar' }).click()
  } finally {
    await control('pinecone', { upsertFalla: null })
  }
})

test('Eliminación con fallo parcial y reintento (HU09)', async ({ page }) => {
  await vista(page, 1280, 900)
  await page.goto('/documentos')
  await page.getByRole('button', { name: 'Eliminar Guia_Estilo_Archivistica.json' }).click()
  const confirmar = page.getByRole('dialog', { name: '¿Eliminar este documento?' })
  await captura(confirmar, '15-eliminar-dialogo.png', 'Eliminar documento.png', 'Confirmación explícita antes de eliminar.')
  await control('pinecone', { borradoDeja: 1 })
  await confirmar.getByRole('checkbox').check()
  await confirmar.getByRole('button', { name: 'Eliminar documento' }).click()
  const parcial = page.getByRole('dialog', { name: 'Eliminación incompleta' })
  await expect(parcial).toBeVisible({ timeout: 60_000 })
  await captura(parcial, '16-eliminacion-incompleta.png', 'Eliminacion incompleta.png', 'El índice conservó 1 embedding: no se informa éxito y el documento queda bloqueado.')
  await control('pinecone', { borradoDeja: 0 })
  await parcial.getByRole('button', { name: 'Reintentar' }).click()
  const exito = page.getByRole('dialog', { name: 'Documento eliminado' })
  await expect(exito).toBeVisible({ timeout: 60_000 })
  await captura(exito, '17-eliminado-exito.png', 'Exito eliminado.png', 'Reintento completo: fragmentos, embeddings y registro retirados.')
})

test('Visor del JSON auténtico y fuente externa (HU04)', async ({ page }) => {
  await vista(page, 1280, 900)
  await page.goto(resultados(PREGUNTA))
  await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible({ timeout: 30_000 })
  await page.locator('.source-card').filter({ hasText: 'Política de viáticos internacionales' }).locator('.source-title-link').click()
  await expect(page.getByText(/SHA-256 verificado/)).toBeVisible()
  await expect(page.locator('.json-usado').first()).toBeVisible()
  await captura(page, '18-visor-json.png', null, 'JSON original de la versión usada: formateado, rutas resaltadas y SHA-256 verificado en el navegador.')
  await captura(page, '19-visor-json-completo.png', null, 'La misma vista completa: JSON, fragmentos indexados con sus rutas y registro técnico.', true)

  await page.goto('/fuentes/rollover_externo')
  await expect(page.getByRole('note')).toBeVisible()
  await captura(page, '20-fuente-externa.png', null, 'Artículo de ForUsGuide: se muestran sus fragmentos indexados y se avisa que no es el JSON original.')
})

test('Móvil (375 px)', async ({ page }) => {
  await vista(page, 375, 812)
  await page.goto('/')
  await expect(page.locator('.suggestion-chip').first()).toBeVisible()
  await sinCursor(page)
  await captura(page, '21-movil-consulta.png', null, 'Consulta en móvil.', true)
  await page.goto(resultados(PREGUNTA))
  await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible({ timeout: 30_000 })
  await captura(page, '22-movil-resultados.png', null, 'Resultados en móvil.', true)
  await page.goto('/documentos')
  await expect(page.locator('tbody tr').first()).toBeVisible()
  await captura(page, '23-movil-documentos.png', null, 'Documentos en móvil: cada artículo como tarjeta.', true)
})
