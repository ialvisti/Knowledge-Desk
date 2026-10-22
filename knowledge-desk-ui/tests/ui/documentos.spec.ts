import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { contratoRespuesta, PREGUNTA_VIATICOS, simularServidor } from './fixtures'

// Artículo kb_article_v2 sintético, con un texto que parece HTML: el visor lo
// muestra como texto y nunca lo interpreta.
const ARTICULO = {
  metadata: { article_id: 'politica_viaticos_internacionales', title: 'Política de viáticos internacionales', record_keeper: null, plan_type: null, schema_version: 'kb_article_v2' },
  details: {
    steps: [
      { step_number: 1, description: 'Ingresa al portal de gastos y abre una solicitud.', notes: null },
      { step_number: 2, description: 'Adjunta las facturas <script>window.inyectado = true</script> originales.', notes: 'Facturas a nombre de la empresa.' },
    ],
    business_rules: [{ category: 'plazos', rules: ['Se solicita dentro de los 15 días posteriores al viaje.'] }],
  },
}
// El original exacto: CRLF y tabulaciones que el visor no debe normalizar.
const ORIGINAL = JSON.stringify(ARTICULO, null, '\t').replace(/\n/g, '\r\n')
const SHA = createHash('sha256').update(ORIGINAL, 'utf8').digest('hex')

const documento = (id: string, nombre: string, estado: string, extra: Record<string, unknown> = {}) => ({
  id, nombre, estado, fechaCarga: '2026-10-20T15:00:00.000Z', fragmentos: estado === 'indexado' ? 4 : null, versionActiva: estado === 'indexado' ? '1.0' : null,
  tipo: 'json', bytes: 2048, articuloId: nombre.replace('.json', '').toLowerCase(), titulo: nombre.replace('.json', '').replace(/_/g, ' '),
  error: estado === 'error' ? { etapa: 'lectura', mensaje: 'El artículo no tiene contenido indexable en "details".' } : null, operacionEnCurso: null, creadoEn: '2026-10-20T15:00:00.000Z', ...extra,
})

const DOCUMENTOS = [
  documento('DOC-0001', 'Política_Privacidad_2023.json', 'indexado'),
  documento('DOC-0002', 'Manual_Operaciones_V2.json', 'procesando'),
  documento('DOC-0005', 'Borrador_Incompleto.json', 'error'),
]

const DETALLE = {
  documento: documento('DOC-0007', 'Politica_Viaticos_v3.2.json', 'indexado', { titulo: 'Política de viáticos internacionales', articuloId: 'politica_viaticos_internacionales' }),
  version: {
    version: '1.0', estado: 'activa', nombre: 'Politica_Viaticos_v3.2.json', tipo: 'json', bytes: Buffer.byteLength(ORIGINAL), sha256: SHA, cargadoEn: '2026-10-20T15:00:00.000Z', fragmentos: 2,
    articulo: { id: 'politica_viaticos_internacionales', titulo: 'Política de viáticos internacionales', recordKeeper: null, planType: null, schemaVersion: 'kb_article_v2', avisos: [] },
    error: null, archivoUrl: '/api/documentos/DOC-0007/archivo?version=1.0',
  },
  fragmentos: [
    { indice: 1, texto: '# Business Rules: Plazos\n\n## Plazos:\n- Se solicita dentro de los 15 días posteriores al viaje.', tipo: 'business_rules', categoria: 'plazos', nivel: 'high', rutas: ['details.business_rules[0]'], parte: null },
    { indice: 2, texto: '# Step-by-Step Procedure\n\n## Step 1: Ingresa al portal de gastos y abre una solicitud.', tipo: 'steps', categoria: 'steps_1_to_2', nivel: 'high', rutas: ['details.steps[0]', 'details.steps[1]'], parte: null },
  ],
  versiones: [{ version: '1.0', estado: 'activa', nombre: 'Politica_Viaticos_v3.2.json', cargadoEn: '2026-10-20T15:00:00.000Z', fragmentos: 2 }],
  operaciones: [],
}

const RUTAS_VISOR = {
  '/api/documentos/DOC-0007': { body: DETALLE },
  '/api/documentos/DOC-0007/archivo': { body: ORIGINAL, contentType: 'application/json; charset=utf-8', headers: { 'x-content-sha256': SHA } },
}

test.describe('HU07–HU09 · Documentos administra artículos JSON', () => {
  test('la carga acepta solo JSON y rechaza otro formato sin enviarlo', async ({ page }) => {
    let cargas = 0
    await simularServidor(page, { documentos: DOCUMENTOS })
    page.on('request', peticion => { if (peticion.method() === 'POST' && peticion.url().endsWith('/api/documentos')) cargas++ })
    await page.goto('/documentos')
    await expect(page.getByText('JSON (Max 50MB)')).toBeVisible()
    const selector = page.getByLabel('Seleccionar artículos JSON')
    await expect(selector).toHaveAttribute('accept', '.json,application/json')
    await selector.setInputFiles({ name: 'Manual.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') })
    await expect(page.getByRole('alert')).toContainText('Manual.pdf: formato no admitido. Carga un artículo de conocimiento en JSON (.json).')
    expect(cargas).toBe(0)
  })

  test('la barra Buscar filtra la tabla por nombre de archivo, sin distinguir acentos ni mayúsculas', async ({ page }) => {
    await simularServidor(page, { documentos: DOCUMENTOS })
    await page.goto('/documentos')
    const filtro = page.getByLabel('Buscar documentos por nombre')
    await filtro.fill('politica')
    await expect(page.locator('tbody tr')).toHaveCount(1)
    await expect(page.locator('tbody tr').first()).toContainText('Política_Privacidad_2023.json')
    await expect(page.getByText('1 documento de 3')).toBeVisible()
    await filtro.fill('inexistente')
    await expect(page.getByText('No hay documentos que coincidan con tu búsqueda.')).toBeVisible()
    await filtro.fill('')
    await expect(page.locator('tbody tr')).toHaveCount(3)
  })

  test('cada fila abre el JSON desde el nombre y tiene solo las acciones Editar y Eliminar', async ({ page }) => {
    await simularServidor(page, { documentos: DOCUMENTOS })
    await page.goto('/documentos')
    const filas = page.locator('tbody tr')
    await expect(filas).toHaveCount(3)
    await expect(filas.first().getByRole('link', { name: 'Política_Privacidad_2023.json' })).toHaveAttribute('href', '/documentos/DOC-0001')
    for (const fila of await filas.all()) await expect(fila.locator('.row-actions > *')).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Editar Política_Privacidad_2023.json' })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Eliminar Manual_Operaciones_V2.json' })).toBeDisabled()
    await page.getByRole('button', { name: 'Ver motivo del error' }).click()
    await expect(page.getByRole('region', { name: 'Motivo del error de Borrador_Incompleto.json' })).toContainText('contenido indexable')
  })
})

test.describe('HU04 · el visor muestra el JSON auténtico de la versión usada', () => {
  test('desde una fuente: JSON formateado y escapado, rutas usadas resaltadas, SHA-256 verificado y original exacto', async ({ page }) => {
    const fuente = {
      id: 'kd_doc0007_v1_0', kind: 'document', title: 'Política de viáticos internacionales', file_name: 'Politica_Viaticos_v3.2.json', article_id: 'politica_viaticos_internacionales',
      href: '/documentos/DOC-0007?version=1.0', document_id: 'DOC-0007', version: '1.0', location: 'details.steps[0–1]', affinity: 0.61, fragment_count: 1,
      fragments: [{ id: 'kd_doc0007_v1_0_chunk_2', affinity: 0.61, type: 'steps', paths: ['details.steps[0]', 'details.steps[1]'], operational: false, content: 'Ingresa al portal…' }],
    }
    await simularServidor(page, { otras: RUTAS_VISOR, consulta: cuerpo => ({ status: 200, body: { ...contratoRespuesta, question: cuerpo.question, sources: [fuente] } }) })
    await page.goto(`/resultados?${new URLSearchParams({ q: PREGUNTA_VIATICOS })}`)
    await expect(page.locator('.source-card')).toContainText('details.steps[0–1]')
    await page.locator('.source-title-link').click()

    await expect(page.getByRole('heading', { level: 1, name: 'Política de viáticos internacionales' })).toBeVisible()
    const visor = page.getByRole('region', { name: 'JSON formateado' })
    await expect(visor).toContainText('"article_id": "politica_viaticos_internacionales"')
    await expect(visor).toContainText('"description": "Adjunta las facturas <script>window.inyectado = true</script> originales."')
    expect(await page.evaluate(() => (window as { inyectado?: boolean }).inyectado)).toBeUndefined()
    await expect(page.locator('.json-usado')).toHaveCount(2)
    await expect(page.locator('.json-usado').first()).toHaveAttribute('data-ruta', 'details.steps[0]')
    await expect(page.getByText(`SHA-256 verificado: ${SHA.slice(0, 16)}`)).toBeVisible()
    await expect(page.getByRole('article', { name: 'Fragmento 2, usado en la respuesta' })).toBeVisible()

    await page.getByRole('button', { name: 'Original exacto' }).click()
    expect(await page.getByRole('region', { name: 'JSON original exacto' }).evaluate(nodo => nodo.textContent)).toBe(ORIGINAL)
    await expect(page.getByRole('link', { name: 'Descargar JSON' })).toHaveAttribute('href', '/api/documentos/DOC-0007/archivo?version=1.0&descargar=1')
  })

  test('copiar entrega el texto original exacto', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'permisos de portapapeles de Chromium')
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await simularServidor(page, { otras: RUTAS_VISOR })
    await page.goto('/documentos/DOC-0007?version=1.0')
    await page.getByRole('button', { name: 'Copiar JSON' }).click()
    await expect(page.getByRole('button', { name: 'JSON copiado' })).toBeVisible()
    // El portapapeles del sistema puede convertir los saltos de línea; el resto es idéntico.
    const copiado = await page.evaluate(() => navigator.clipboard.readText())
    expect(copiado.replace(/\r\n/g, '\n')).toBe(ORIGINAL.replace(/\r\n/g, '\n'))
  })

  test('una fuente de ForUsGuide dice que muestra fragmentos indexados, no el JSON original', async ({ page }) => {
    await simularServidor(page, {
      otras: {
        '/api/fuentes/rollover_401k': { body: { tipo: 'articulo_externo', origen: 'fragmentos_indexados', articleId: 'rollover_401k', titulo: 'Rollover', fragmentos: [{ id: 'rollover_401k_chunk_1', indice: 1, tipo: 'steps', contenido: 'Paso uno.' }] } },
      },
    })
    await page.goto('/fuentes/rollover_401k')
    await expect(page.getByRole('note')).toContainText('ForUsGuide no expone el archivo JSON original de este artículo')
    await expect(page.getByRole('region', { name: 'JSON formateado' })).toContainText('"origen": "fragmentos_indexados"')
  })
})

test.describe('Modo demostración', () => {
  test('el stack simulado se declara como tal y no muestra un modelo real', async ({ page }) => {
    await simularServidor(page, { estado: { simulado: true }, consulta: cuerpo => ({ status: 200, body: { ...contratoRespuesta, question: cuerpo.question, retrieval: { ...contratoRespuesta.retrieval, model: 'simulado' } } }) })
    await page.goto('/')
    await expect(page.getByText(/Modo demostración · índice y respuestas simulados/)).toBeVisible()
    await page.goto(`/resultados?${new URLSearchParams({ q: PREGUNTA_VIATICOS })}`)
    await expect(page.getByText(/respuesta simulada \(demostración\)/)).toBeVisible()
    await expect(page.getByText('gpt-5.5')).toHaveCount(0)
  })
})

test.describe('Vista previa con datos temporales', () => {
  const aviso = /vista previa con datos temporales: los artículos cargados se pierden al reiniciar o redesplegar/

  test('Documentos lo avisa solo si el servidor lo declara, sin presentarlo como demostración', async ({ page }) => {
    await simularServidor(page, { documentos: DOCUMENTOS, estado: { datosTemporales: true } })
    await page.goto('/documentos')
    await expect(page.locator('.document-list-footer')).toContainText(aviso)
    await expect(page.getByText(/simulad/)).toHaveCount(0)
  })

  test('sin la marca, el pie de Documentos queda como en la referencia', async ({ page }) => {
    await simularServidor(page, { documentos: DOCUMENTOS })
    await page.goto('/documentos')
    await expect(page.locator('.document-list-footer')).toContainText('Índice:')
    await expect(page.locator('.document-list-footer')).not.toContainText(aviso)
  })
})
