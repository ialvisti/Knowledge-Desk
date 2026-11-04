import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { construirApp, construirServicios, type Servicios } from '../src/app.ts'
import { loadConfig, type Config } from '../src/config.ts'
import { multipart } from './support/entorno.ts'
import { crearLlmSimulado, redacciones } from './support/llm-simulado.ts'
import { iniciarPineconeSimulado, type PineconeSimulado } from './support/pinecone-simulado.ts'

// Descargas de documentos y fuentes (CP-HU08-09, CP-HU04-06), persistencia de
// un documento cargado al recargar (CP-HU07-13) y consulta de un documento con
// contenido exclusivo (CP-HU07-08), en el modo directo con Pinecone simulado
// por sus rutas reales y un LLM simulado que cuenta sus llamadas.
const NS_BASE = 'kb_articles'
const NS_DOCS = 'knowledge_desk_documents'
const sha256 = (datos: Buffer | string) => createHash('sha256').update(datos).digest('hex')

const V1 = `Protocolo ficticio Zafiro de custodia de llaves

Reglas
La llave maestra Zafiro debe devolverse en recepción antes de las 18:00 del mismo día.
`
const V2 = `Protocolo ficticio Zafiro de custodia de llaves

Reglas
La llave maestra Zafiro debe devolverse en recepción antes de las 20:00 del mismo día.
`

describe('Descargas, persistencia y consulta de documentos cargados', () => {
  let dir: string
  let pinecone: PineconeSimulado
  let llm: ReturnType<typeof crearLlmSimulado>
  let config: Config
  let servicios: Servicios
  let app: FastifyInstance

  async function montar() {
    servicios = await construirServicios(config, { fetchProveedor: llm.fetch, pineconeMaxRetries: 0 })
    app = await construirApp(servicios, { logger: false })
  }

  before(async () => { pinecone = await iniciarPineconeSimulado() })
  beforeEach(async () => {
    await app?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = await mkdtemp(path.join(os.tmpdir(), 'kd-descargas-'))
    await writeFile(path.join(dir, 'ejemplos.json'), JSON.stringify({ directo: [] }))
    pinecone.registros.clear()
    pinecone.peticiones.length = 0
    // Corpus base: un artículo relacionado con llaves y otro ajeno con palabras parecidas.
    pinecone.registros.set('llaves_base_chunk_1', { _id: 'llaves_base_chunk_1', content: 'Custodia de llaves del edificio: las llaves comunes se registran en recepción.', article_id: 'llaves_base', article_title: 'Llaves del edificio', chunk_type: 'business_rules', chunk_index: 1, visibleDesde: 0, __ns: NS_BASE })
    pinecone.registros.set('llaves_base_chunk_2', { _id: 'llaves_base_chunk_2', content: 'Custodia de llaves: la pérdida de una llave se informa a seguridad.', article_id: 'llaves_base', article_title: 'Llaves del edificio', chunk_type: 'steps', chunk_index: 2, visibleDesde: 0, __ns: NS_BASE })
    pinecone.registros.set('ajeno_chunk_1', { _id: 'ajeno_chunk_1', content: 'Custodia de llaves de vehículos de la flota.', article_id: 'ajeno', article_title: 'Flota', chunk_type: 'steps', chunk_index: 1, visibleDesde: 0, __ns: NS_BASE })
    llm = crearLlmSimulado()
    llm.subconsultas = []
    config = loadConfig({
      KD_MODO: 'directo', PINECONE_API_KEY: 'pinecone-sintetica-descargas-0123456789', PINECONE_INDEX_HOST: pinecone.url, PINECONE_NAMESPACE: NS_BASE,
      KD_LLM_BASE_URL: 'http://llm.simulado/v1', KD_LLM_API_KEY: 'llm-sintetica-descargas-0123456789', KD_CHAT_MODEL: 'gpt-simulado',
      KD_DATA_DIR: path.join(dir, 'datos'), KD_UI_DIST: path.join(dir, 'sin-ui'), KD_EJEMPLOS_ARCHIVO: path.join(dir, 'ejemplos.json'),
      KD_VERIFICACION_INDICE_MS: '1500', KD_VERIFICACION_INTERVALO_MS: '20',
    })
    await montar()
  })
  after(async () => {
    await app?.close()
    await pinecone.cerrar()
    await rm(dir, { recursive: true, force: true })
  })

  async function cargar(nombre: string, contenido: string) {
    const respuesta = await app.inject({ method: 'POST', url: '/api/documentos', ...multipart(nombre, Buffer.from(contenido, 'utf8')) })
    assert.equal(respuesta.statusCode, 202)
    await servicios.gestor.esperarInactividad()
    return respuesta.json().documento.id as string
  }
  const preguntar = async (question: string) => (await app.inject({ method: 'POST', url: '/api/consulta', payload: { question } })).json()
  const kd = () => [...pinecone.registros.values()].filter(registro => registro.__ns === NS_DOCS)

  it('CP-HU08-09 · la descarga de un documento entrega el original exacto como adjunto, con su nombre y SHA-256', async () => {
    const id = await cargar('protocolo-zafiro.txt', V1)
    // Sin versión: la vigente. Con versión: esa versión.
    for (const url of [`/api/documentos/${id}/archivo?descargar=1`, `/api/documentos/${id}/archivo?version=1.0&descargar=1`]) {
      const descarga = await app.inject({ method: 'GET', url })
      assert.equal(descarga.statusCode, 200)
      assert.ok(descarga.rawPayload.equals(Buffer.from(V1, 'utf8')))
      assert.equal(descarga.headers['x-content-sha256'], sha256(V1))
      assert.equal(descarga.headers['content-disposition'], "attachment; filename*=UTF-8''protocolo-zafiro.txt")
      assert.equal(descarga.headers['content-type'], 'text/plain; charset=utf-8')
    }
  })

  it('CP-HU04-06 · la fuente de un documento descarga el original exacto de la VERSIÓN citada, también tras reemplazarla', async () => {
    const id = await cargar('protocolo-zafiro.txt', V1)
    llm.redaccion = () => ({ respuesta: 'La llave maestra Zafiro se devuelve en recepción [1].', puntos_clave: [], vacios_de_cobertura: [], contradicciones: [] })
    const antes = await preguntar('¿Cuándo se devuelve la llave maestra Zafiro?')
    const fuenteV1 = antes.sources.find((fuente: { kind: string }) => fuente.kind === 'document')
    assert.deepEqual(fuenteV1.download, { kind: 'original', label: 'Descargar original', url: `/api/documentos/${id}/archivo?version=1.0&descargar=1`, file_name: 'protocolo-zafiro.txt' })

    const reemplazo = await app.inject({ method: 'POST', url: `/api/documentos/${id}/reemplazo`, ...multipart('protocolo-zafiro-v2.txt', Buffer.from(V2, 'utf8')) })
    assert.equal(reemplazo.statusCode, 202)
    await servicios.gestor.esperarInactividad()

    // La respuesta anterior sigue descargando v1, no la versión nueva.
    const descargaV1 = await app.inject({ method: 'GET', url: fuenteV1.download.url })
    assert.ok(descargaV1.rawPayload.equals(Buffer.from(V1, 'utf8')))
    assert.equal(descargaV1.headers['x-content-sha256'], sha256(V1))

    const despues = await preguntar('¿Cuándo se devuelve la llave maestra Zafiro?')
    const fuenteV2 = despues.sources.find((fuente: { kind: string }) => fuente.kind === 'document')
    assert.equal(fuenteV2.version, '1.1')
    assert.equal(fuenteV2.download.url, `/api/documentos/${id}/archivo?version=1.1&descargar=1`)
    assert.equal(fuenteV2.download.file_name, 'protocolo-zafiro-v2.txt')
    const descargaV2 = await app.inject({ method: 'GET', url: fuenteV2.download.url })
    assert.ok(descargaV2.rawPayload.equals(Buffer.from(V2, 'utf8')))
  })

  it('CP-HU04-06 · un artículo del corpus base descarga su texto indexado como TXT declarado, sin presentarlo como original ni mezclar otro artículo', async () => {
    llm.redaccion = () => ({ respuesta: 'Las llaves comunes se registran en recepción [1].', puntos_clave: [], vacios_de_cobertura: [], contradicciones: [] })
    const respuesta = await preguntar('¿Dónde se registra la custodia de llaves del edificio?')
    const fuente = respuesta.sources.find((item: { id: string }) => item.id === 'llaves_base')
    assert.ok(fuente, 'el artículo base es fuente')
    assert.equal(fuente.kind, 'external_article')
    assert.deepEqual(fuente.download, { kind: 'texto_indexado', label: 'Descargar texto de la fuente', url: '/api/fuentes/llaves_base/texto', file_name: 'llaves_base-texto-indexado.txt' })

    const descarga = await app.inject({ method: 'GET', url: fuente.download.url })
    assert.equal(descarga.statusCode, 200)
    assert.equal(descarga.headers['content-type'], 'text/plain; charset=utf-8')
    assert.equal(descarga.headers['content-disposition'], 'attachment; filename="llaves_base-texto-indexado.txt"')
    assert.equal(descarga.headers['x-content-sha256'], sha256(descarga.rawPayload))
    const lineas = descarga.body.split('\n')
    assert.match(lineas[0], /^Texto indexado de la fuente\. No es el archivo original/)
    assert.equal(lineas[2], 'ID: llaves_base')
    assert.equal(lineas[3], 'Fragmentos: 2')
    assert.match(descarga.body, /las llaves comunes se registran en recepción/)
    assert.match(descarga.body, /la pérdida de una llave se informa a seguridad/)
    assert.doesNotMatch(descarga.body, /vehículos de la flota/, 'no incluye fragmentos de otro artículo')
    assert.ok(pinecone.peticiones.every(item => item.namespace !== NS_BASE || item.ruta.endsWith('/search')), 'el corpus base solo se lee')

    // Un documento de Knowledge Desk no se exporta como texto: se descarga su original.
    const kdTexto = await app.inject({ method: 'GET', url: '/api/fuentes/kd_doc0001_v1_0/texto' })
    assert.equal(kdTexto.statusCode, 404)
    assert.equal(kdTexto.json().code, 'SOURCE_NOT_AVAILABLE')
    const inexistente = await app.inject({ method: 'GET', url: '/api/fuentes/no_existe/texto' })
    assert.equal(inexistente.statusCode, 404)
  })

  it('CP-HU07-13 · original, metadatos, fragmentos y embeddings coinciden al terminar la carga, al recargar y al reiniciar el servidor sobre el mismo directorio', async () => {
    const id = await cargar('protocolo-zafiro.txt', V1)
    const instantanea = async () => {
      const lista = (await app.inject({ method: 'GET', url: '/api/documentos' })).json()
      const detalle = (await app.inject({ method: 'GET', url: `/api/documentos/${id}` })).json()
      const original = await app.inject({ method: 'GET', url: detalle.version.archivoUrl })
      const texto = await app.inject({ method: 'GET', url: detalle.version.texto.url })
      const fila = lista.documentos.find((doc: { id: string }) => doc.id === id)
      return {
        fila: { estado: fila.estado, fragmentos: fila.fragmentos, versionActiva: fila.versionActiva, tipo: fila.tipo, bytes: fila.bytes, titulo: fila.titulo },
        metadatos: { sha256: detalle.version.sha256, nombre: detalle.version.nombre, articulo: detalle.version.articulo, texto: { caracteres: detalle.version.texto.caracteres, bloques: detalle.version.texto.bloques } },
        originalSha: sha256(original.rawPayload),
        textoSha: sha256(texto.rawPayload),
        fragmentos: detalle.fragmentos.map((item: { indice: number; texto: string; tipo: string; rutas: string[] }) => [item.indice, sha256(item.texto), item.tipo, item.rutas.join(',')]),
        embeddings: kd().filter(registro => registro.kd_document_id === id).map(registro => [registro._id, sha256(String(registro.content)), registro.chunk_type]).sort(),
      }
    }
    const alCargar = await instantanea()
    assert.equal(alCargar.fila.estado, 'indexado')
    assert.equal(alCargar.originalSha, sha256(V1))
    assert.equal(alCargar.fila.fragmentos, alCargar.fragmentos.length)
    assert.equal(alCargar.embeddings.length, alCargar.fragmentos.length, 'un embedding por fragmento')

    // Recargar la vista = volver a pedir la lista y el detalle.
    assert.deepEqual(await instantanea(), alCargar)
    // Reiniciar el proceso con el mismo directorio de datos (no un redespliegue en /tmp).
    await app.close()
    await montar()
    assert.deepEqual(await instantanea(), alCargar)
  })

  it('CP-HU07-08 · un documento con contenido exclusivo se recupera en la consulta principal y se muestra como fuente con sus fragmentos', async () => {
    const id = await cargar('protocolo-zafiro.txt', V1)
    llm.redaccion = () => ({ respuesta: 'La llave maestra Zafiro debe devolverse en recepción antes de las 18:00 [1].', puntos_clave: [], vacios_de_cobertura: [], contradicciones: [] })
    const respuesta = await preguntar('¿Hasta qué hora se devuelve la llave maestra Zafiro?')
    assert.equal(respuesta.outcome, 'answered')
    assert.match(respuesta.answer, /18:00/)
    const fuente = respuesta.sources.find((item: { kind: string }) => item.kind === 'document')
    assert.equal(fuente.document_id, id)
    assert.equal(fuente.file_name, 'protocolo-zafiro.txt')
    assert.equal(fuente.href, `/documentos/${id}?version=1.0`)
    assert.ok(fuente.fragments.some((fragmento: { content: string }) => fragmento.content.includes('antes de las 18:00')))
    assert.ok(fuente.fragments.every((fragmento: { id: string }) => fragmento.id.startsWith(`kd_${id.toLowerCase().replace('-', '')}_v1_0_chunk_`)))
    // Se consultó el índice (base y documentos) y se redactó una vez: es la consulta con LLM, no una búsqueda local de palabras.
    assert.ok(pinecone.peticiones.some(item => item.ruta === `/records/namespaces/${NS_DOCS}/search`))
    assert.equal(redacciones(llm.llamadas).length, 1)
  })
})
