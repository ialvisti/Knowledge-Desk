import { createHash } from 'node:crypto'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { contratoRespuesta, PREGUNTA_VIATICOS, simularServidor } from './fixtures'

// CP-HU08-09 y CP-HU04-06 en la interfaz: acciones sobre el documento
// seleccionado (tabla y detalle) y descarga desde cada tarjeta de fuente.
// Chromium cancela las descargas que sirve una ruta interceptada, así que aquí
// se comprueban el enlace (href y nombre de descarga) y los bytes que entrega
// esa URL dentro de la página. La descarga real del navegador, con su archivo,
// se prueba contra el servidor real en tests/e2e/flujo.spec.ts.
const ORIGINAL_TXT = 'Protocolo ficticio Zafiro\r\nLa llave maestra se devuelve antes de las 18:00.\r\n'
const TEXTO_INDEXADO = 'Texto indexado de la fuente. No es el archivo original: el corpus base solo expone sus fragmentos indexados.\nArtículo: Llaves del edificio\nID: llaves_base\nFragmentos: 1\n\n--- Fragmento 1 · business_rules ---\nLas llaves comunes se registran en recepción.\n'
const sha = (datos: Buffer | string) => createHash('sha256').update(datos).digest('hex')

const documento = (id: string, nombre: string, versionActiva: string | null, estado = versionActiva ? 'indexado' : 'error') => ({
  id, nombre, estado, fechaCarga: '2026-11-04T15:00:00.000Z', fragmentos: versionActiva ? 2 : null, versionActiva, tipo: 'txt', bytes: Buffer.byteLength(ORIGINAL_TXT),
  articuloId: 'protocolo_zafiro_txt', titulo: 'Protocolo ficticio Zafiro', error: versionActiva ? null : { etapa: 'lectura', mensaje: 'Sin texto útil.' }, operacionEnCurso: null, creadoEn: '2026-11-04T15:00:00.000Z',
})

const DETALLE = {
  documento: documento('DOC-0004', 'protocolo-zafiro.txt', '1.1'),
  version: {
    version: '1.1', estado: 'activa', nombre: 'protocolo-zafiro.txt', tipo: 'txt', bytes: Buffer.byteLength(ORIGINAL_TXT), sha256: sha(ORIGINAL_TXT), cargadoEn: '2026-11-04T15:00:00.000Z', fragmentos: 1,
    articulo: { id: 'protocolo_zafiro_txt', titulo: 'Protocolo ficticio Zafiro', recordKeeper: null, planType: null, schemaVersion: null, avisos: [] },
    error: null, archivoUrl: '/api/documentos/DOC-0004/archivo?version=1.1', texto: { caracteres: 70, bloques: 2, url: '/api/documentos/DOC-0004/texto?version=1.1' },
  },
  fragmentos: [{ indice: 1, texto: 'Protocolo ficticio Zafiro\nLa llave maestra se devuelve antes de las 18:00.', tipo: 'business_rules', categoria: 'Protocolo ficticio Zafiro', nivel: 'high', rutas: ['bloques[2]'], parte: null }],
  versiones: [{ version: '1.1', estado: 'activa', nombre: 'protocolo-zafiro.txt', cargadoEn: '2026-11-04T15:00:00.000Z', fragmentos: 1 }],
  operaciones: [],
}

const adjunto = (body: string, nombre: string, contentType: string) => ({ body, contentType, headers: { 'content-disposition': `attachment; filename="${nombre}"`, 'x-content-sha256': sha(body) } })

// Nombre de descarga del enlace y bytes que entrega su URL en la página.
async function descargar(page: Page, enlace: Locator): Promise<{ nombre: string; bytes: Buffer }> {
  const href = await enlace.getAttribute('href')
  const nombre = await enlace.getAttribute('download')
  expect(href).toBeTruthy()
  expect(nombre).toBeTruthy()
  const datos = await page.evaluate(async url => Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())), href!)
  return { nombre: nombre!, bytes: Buffer.from(datos) }
}

test.describe('CP-HU08-09 · acciones sobre el documento seleccionado', () => {
  test('la tabla ofrece Visualizar, Descargar, Editar y Eliminar; Descargar entrega el original exacto', async ({ page }) => {
    await simularServidor(page, {
      documentos: [documento('DOC-0004', 'protocolo-zafiro.txt', '1.1'), documento('DOC-0005', 'roto.txt', null)],
      otras: { '/api/documentos/DOC-0004/archivo?version=1.1&descargar=1': adjunto(ORIGINAL_TXT, 'protocolo-zafiro.txt', 'text/plain; charset=utf-8') },
    })
    await page.goto('/documentos')
    const fila = page.locator('tbody tr').filter({ hasText: 'protocolo-zafiro.txt' })
    await expect(fila.getByRole('link', { name: 'Visualizar protocolo-zafiro.txt' })).toHaveAttribute('href', '/documentos/DOC-0004')
    await expect(fila.getByRole('button', { name: 'Editar protocolo-zafiro.txt' })).toBeEnabled()
    await expect(fila.getByRole('button', { name: 'Eliminar protocolo-zafiro.txt' })).toBeEnabled()
    const { nombre, bytes } = await descargar(page, fila.getByRole('link', { name: 'Descargar protocolo-zafiro.txt' }))
    expect(nombre).toBe('protocolo-zafiro.txt')
    expect(sha(bytes)).toBe(sha(ORIGINAL_TXT))
    // Sin versión vigente no hay original que descargar.
    await expect(page.locator('tbody tr').filter({ hasText: 'roto.txt' }).getByRole('button', { name: 'Descargar roto.txt' })).toBeDisabled()

    await fila.getByRole('link', { name: 'Visualizar protocolo-zafiro.txt' }).click()
    await expect(page).toHaveURL(/\/documentos\/DOC-0004$/)
  })

  test('el detalle ofrece Descargar original, Editar y Eliminar sobre el documento abierto', async ({ page }) => {
    await simularServidor(page, {
      otras: {
        '/api/documentos/DOC-0004': { body: DETALLE },
        '/api/documentos/DOC-0004/texto': { body: 'Protocolo ficticio Zafiro\nLa llave maestra se devuelve antes de las 18:00.', contentType: 'text/plain; charset=utf-8' },
        '/api/documentos/DOC-0004/archivo?version=1.1&descargar=1': adjunto(ORIGINAL_TXT, 'protocolo-zafiro.txt', 'text/plain; charset=utf-8'),
      },
    })
    await page.goto('/documentos/DOC-0004')
    const acciones = page.getByRole('group', { name: 'Acciones del documento' })
    const { nombre, bytes } = await descargar(page, acciones.getByRole('link', { name: 'Descargar original' }))
    expect(nombre).toBe('protocolo-zafiro.txt')
    expect(bytes.equals(Buffer.from(ORIGINAL_TXT, 'utf8'))).toBe(true)
    expect(sha(bytes)).toBe(DETALLE.version.sha256)

    await acciones.getByRole('button', { name: 'Editar' }).click()
    await expect(page.getByRole('dialog', { name: 'Reemplazar documento' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Reemplazar documento' })).toHaveCount(0)
    await acciones.getByRole('button', { name: 'Eliminar' }).click()
    await expect(page.getByRole('dialog', { name: '¿Eliminar este documento?' })).toBeVisible()
  })
})

test.describe('CP-HU04-06 · descargar desde cada tarjeta de fuente', () => {
  test('documento: original exacto de la versión citada; artículo base: texto indexado declarado como tal', async ({ page }) => {
    const base = contratoRespuesta.sources[0]
    const fuenteDocumento = {
      ...base, id: 'kd_doc0004_v1_1', kind: 'document', title: 'Protocolo ficticio Zafiro', file_name: 'protocolo-zafiro.txt', article_id: 'protocolo_zafiro_txt', href: '/documentos/DOC-0004?version=1.1',
      document_id: 'DOC-0004', version: '1.1', location: 'bloques[2]', affinity: 0.66, fragment_count: 1,
      fragments: [{ id: 'kd_doc0004_v1_1_chunk_1', affinity: 0.66, type: 'business_rules', paths: ['bloques[2]'], operational: false, content: 'La llave maestra se devuelve antes de las 18:00.' }],
      download: { kind: 'original', label: 'Descargar original', url: '/api/documentos/DOC-0004/archivo?version=1.1&descargar=1', file_name: 'protocolo-zafiro.txt' },
    }
    const fuenteBase = {
      ...base, id: 'llaves_base', kind: 'external_article', title: 'Llaves del edificio', href: '/fuentes/llaves_base', document_id: null, version: null, affinity: 0.52,
      download: { kind: 'texto_indexado', label: 'Descargar texto de la fuente', url: '/api/fuentes/llaves_base/texto', file_name: 'llaves_base-texto-indexado.txt' },
    }
    const sinDescarga = { ...base, id: 'otra_base', title: 'Fuente sin descarga', href: '/fuentes/otra_base', affinity: 0.4, download: null }
    await simularServidor(page, {
      consulta: cuerpo => ({ status: 200, body: { ...contratoRespuesta, question: cuerpo.question, sources: [fuenteDocumento, fuenteBase, sinDescarga] } }),
      otras: {
        '/api/documentos/DOC-0004/archivo?version=1.1&descargar=1': adjunto(ORIGINAL_TXT, 'protocolo-zafiro.txt', 'text/plain; charset=utf-8'),
        '/api/fuentes/llaves_base/texto': adjunto(TEXTO_INDEXADO, 'llaves_base-texto-indexado.txt', 'text/plain; charset=utf-8'),
      },
    })
    await page.goto(`/resultados?${new URLSearchParams({ q: PREGUNTA_VIATICOS })}`)

    const tarjetaDoc = page.locator('.source-card').filter({ hasText: 'Protocolo ficticio Zafiro' })
    const enlaceDoc = tarjetaDoc.getByRole('link', { name: 'Descargar original: Protocolo ficticio Zafiro' })
    await expect(enlaceDoc).toHaveAttribute('href', '/api/documentos/DOC-0004/archivo?version=1.1&descargar=1')
    const original = await descargar(page, enlaceDoc)
    expect(original.nombre).toBe('protocolo-zafiro.txt')
    expect(original.bytes.equals(Buffer.from(ORIGINAL_TXT, 'utf8'))).toBe(true)

    const tarjetaBase = page.locator('.source-card').filter({ hasText: 'Llaves del edificio' })
    await expect(tarjetaBase.getByRole('link', { name: /Descargar original/ })).toHaveCount(0)
    const enlaceBase = tarjetaBase.getByRole('link', { name: 'Descargar texto de la fuente: Llaves del edificio' })
    await expect(enlaceBase).toContainText('Descargar texto de la fuente')
    const texto = await descargar(page, enlaceBase)
    expect(texto.nombre).toBe('llaves_base-texto-indexado.txt')
    expect(texto.bytes.toString('utf8')).toBe(TEXTO_INDEXADO)
    expect(texto.bytes.toString('utf8').split('\n')[0]).toMatch(/No es el archivo original/)

    await expect(page.locator('.source-card').filter({ hasText: 'Fuente sin descarga' }).locator('.source-download')).toHaveCount(0)
  })
})
