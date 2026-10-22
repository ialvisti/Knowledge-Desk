import { expect, test, type Page } from '@playwright/test'
import { PUERTOS } from '../../playwright.config'

// Flujo completo contra el servidor REAL de Knowledge Desk en modo simulado:
// el pipeline documental, el índice (Pinecone simulado) y el endpoint de
// consulta (ForUsGuide simulado) corren de verdad en este equipo. Nada sale a
// Internet. Los artículos son kb_article_v2 sintéticos.
test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

const PREGUNTA = '¿Cuál es el procedimiento para reembolso de viáticos internacionales?'

function articulo(version: 'v1' | 'v2') {
  const plazo = version === 'v1' ? 'dentro de los 15 días posteriores al viaje' : 'dentro de los 10 días hábiles posteriores al viaje'
  return {
    metadata: { article_id: 'e2e_viaticos_internacionales', title: 'E2E · Política de viáticos internacionales', record_keeper: null, plan_type: null, schema_version: 'kb_article_v2', description: 'Reembolso de viáticos internacionales.' },
    details: {
      business_rules: [{ category: 'plazos', rules: [`El reembolso de viáticos internacionales se solicita en el portal de gastos ${plazo}.`] }],
      steps: [
        { step_number: 1, description: 'Ingresa al portal de gastos y abre una solicitud de reembolso de viáticos internacionales.', notes: null },
        { step_number: 2, description: 'Adjunta las facturas y el formato de legalización del viaje internacional.', notes: null },
      ],
    },
  }
}

const archivo = (nombre: string, contenido: unknown) => ({ name: nombre, mimeType: 'application/json', buffer: Buffer.from(typeof contenido === 'string' ? contenido : JSON.stringify(contenido, null, 2)) })

async function control(servicio: 'pinecone' | 'forusguide', datos: Record<string, unknown>) {
  const respuesta = await fetch(`http://127.0.0.1:${PUERTOS[servicio]}/__control`, { method: 'POST', body: JSON.stringify(datos) })
  expect(respuesta.ok).toBe(true)
}

const fila = (page: Page, nombre: string) => page.locator('tbody tr').filter({ has: page.getByRole('link', { name: nombre, exact: true }) })

async function cargar(page: Page, ...archivos: ReturnType<typeof archivo>[]) {
  await page.goto('/documentos')
  await page.getByLabel('Seleccionar artículos JSON').setInputFiles(archivos)
}

test('HU07: un artículo JSON válido se indexa de verdad y queda Indexado con sus fragmentos', async ({ page }) => {
  await cargar(page, archivo('E2E_Viaticos.json', articulo('v1')))
  await expect(page.getByRole('status').filter({ hasText: 'E2E_Viaticos.json: artículo "E2E · Política de viáticos internacionales" recibido' })).toBeVisible()
  await expect(fila(page, 'E2E_Viaticos.json').getByText('Indexado', { exact: true })).toBeVisible({ timeout: 30_000 })
  // Una regla de negocio y un grupo de dos pasos: dos fragmentos.
  await expect(fila(page, 'E2E_Viaticos.json').locator('td[data-label="Fragmentos"]')).toHaveText('2')
})

test('HU07: JSON mal formado, otro formato y artículo sin contenido indexable se rechazan o quedan en Error', async ({ page }) => {
  await cargar(page, archivo('Roto.json', '{"metadata": {'), { name: 'Manual.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') })
  await expect(page.getByRole('alert').filter({ hasText: 'Manual.pdf: formato no admitido' })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: /No fue posible cargar Roto\.json\. Roto\.json: no es JSON válido/ })).toBeVisible()
  await expect(fila(page, 'Roto.json')).toHaveCount(0)

  const vacio = { metadata: { article_id: 'e2e_vacio', title: 'E2E vacío', record_keeper: null, plan_type: null }, details: { notas_internas: 'Texto que no pertenece a ninguna sección del esquema kb_article_v2.', steps: [] } }
  await cargar(page, archivo('E2E_Vacio.json', vacio))
  await expect(fila(page, 'E2E_Vacio.json').getByText('Error', { exact: true })).toBeVisible({ timeout: 30_000 })
  await fila(page, 'E2E_Vacio.json').getByRole('button', { name: 'Ver motivo del error' }).click()
  await expect(page.getByRole('region', { name: 'Motivo del error de E2E_Vacio.json' })).toContainText('no tiene contenido indexable')
})

test('HU02–HU04: la consulta se responde con el artículo y la fuente abre su JSON auténtico con las rutas usadas', async ({ page }) => {
  await page.goto(`/resultados?${new URLSearchParams({ q: PREGUNTA })}`)
  await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/respuesta simulada \(demostración\)/)).toBeVisible()
  const tarjeta = page.locator('.source-card').filter({ hasText: 'E2E · Política de viáticos internacionales' })
  await expect(tarjeta).toContainText(/details\.(steps|business_rules)/)
  await tarjeta.locator('.source-title-link').click()

  await expect(page.getByRole('heading', { level: 1, name: 'E2E · Política de viáticos internacionales' })).toBeVisible()
  await expect(page.getByText(/SHA-256 verificado/)).toBeVisible()
  await expect(page.locator('.json-usado').first()).toBeVisible()
  await expect(page.getByRole('region', { name: 'JSON formateado' })).toContainText('"article_id": "e2e_viaticos_internacionales"')
  await page.getByRole('button', { name: 'Original exacto' }).click()
  expect(await page.getByRole('region', { name: 'JSON original exacto' }).textContent()).toBe(JSON.stringify(articulo('v1'), null, 2))
})

test('HU08: reemplazar por otra versión del mismo artículo la activa y las respuestas usan solo la nueva', async ({ page }) => {
  await page.goto('/documentos')
  await page.getByRole('button', { name: 'Editar E2E_Viaticos.json' }).click()
  const dialogo = page.getByRole('dialog', { name: 'Reemplazar documento' })
  await dialogo.getByLabel('Seleccionar el nuevo artículo JSON').setInputFiles(archivo('E2E_Viaticos_v2.json', articulo('v2')))
  await dialogo.getByRole('checkbox').check()
  await dialogo.getByRole('button', { name: 'Reemplazar documento' }).click()
  await expect(page.getByRole('dialog', { name: 'Documento reemplazado' })).toContainText('La versión v1.1 ya está activa', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Volver a documentos' }).click()

  await page.goto(`/resultados?${new URLSearchParams({ q: PREGUNTA })}`)
  await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible({ timeout: 30_000 })
  const tarjeta = page.locator('.source-card').filter({ hasText: 'E2E · Política de viáticos internacionales' })
  await expect(tarjeta.locator('.source-title-link')).toHaveAttribute('href', /\?version=1\.1$/)
  await expect(page.getByText('15 días posteriores')).toHaveCount(0)
})

test('HU08: un archivo de otro artículo no puede reemplazarlo', async ({ page }) => {
  await page.goto('/documentos')
  await page.getByRole('button', { name: 'Editar E2E_Viaticos_v2.json' }).click()
  const dialogo = page.getByRole('dialog', { name: 'Reemplazar documento' })
  const otro = { ...articulo('v1'), metadata: { ...articulo('v1').metadata, article_id: 'otro_articulo' } }
  await dialogo.getByLabel('Seleccionar el nuevo artículo JSON').setInputFiles(archivo('Otro.json', otro))
  await dialogo.getByRole('checkbox').check()
  await dialogo.getByRole('button', { name: 'Reemplazar documento' }).click()
  await expect(dialogo.getByRole('alert')).toContainText('corresponde al artículo "otro_articulo"')
})

test('HU09: una eliminación parcial bloquea el artículo, no se informa como éxito y el reintento la completa', async ({ page }) => {
  await control('pinecone', { borradoDeja: 1 })
  await page.goto('/documentos')
  await page.getByRole('button', { name: 'Eliminar E2E_Viaticos_v2.json' }).click()
  const confirmar = page.getByRole('dialog', { name: '¿Eliminar este documento?' })
  await confirmar.getByRole('checkbox').check()
  await confirmar.getByRole('button', { name: 'Eliminar documento' }).click()
  const parcial = page.getByRole('dialog', { name: 'Eliminación incompleta' })
  await expect(parcial).toContainText('Queda 1 embedding asociado', { timeout: 60_000 })
  await expect(parcial).toContainText('Fallido - parcial')

  // Mientras tanto, ninguna respuesta se apoya en lo que quedó en el índice.
  const consulta = await page.context().newPage()
  await consulta.goto(`/resultados?${new URLSearchParams({ q: PREGUNTA })}`)
  await expect(consulta.getByRole('heading', { name: 'Un documento de la respuesta no está disponible' })).toBeVisible({ timeout: 30_000 })
  await consulta.close()

  await control('pinecone', { borradoDeja: 0 })
  await parcial.getByRole('button', { name: 'Reintentar' }).click()
  await expect(page.getByRole('dialog', { name: 'Documento eliminado' })).toContainText('Ya no aparecerá como fuente', { timeout: 60_000 })
  await page.getByRole('button', { name: 'Volver a documentos' }).click()
  await expect(fila(page, 'E2E_Viaticos_v2.json')).toHaveCount(0)
})

test('HU10: un fallo del servicio de consulta se informa con su tipo e ID de soporte', async ({ page }) => {
  await control('forusguide', { fallo: 'retrieval' })
  try {
    await page.goto(`/resultados?${new URLSearchParams({ q: PREGUNTA })}`)
    await expect(page.getByRole('heading', { name: 'No pudimos buscar en los documentos' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/ID de soporte: req-[0-9a-f]{8}/)).toBeVisible()
  } finally {
    await control('forusguide', { fallo: null })
  }
})
