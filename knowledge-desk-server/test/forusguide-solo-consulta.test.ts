import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { construirApp, construirServicios } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { articuloSimple, json } from './support/articulos.ts'
import { iniciarForUsGuideSimulado, type ForUsGuideSimulado } from './support/forusguide-simulado.ts'
import { multipart } from './support/entorno.ts'
import { iniciarPineconeSimulado, type PineconeSimulado } from './support/pinecone-simulado.ts'

// Vista previa pública con ForUsGuide como motor de consulta y SIN escritura en
// el índice compartido: KD_MODO=forusguide, sin PINECONE_*, KD_ACCESO_PUBLICO=true.
// ForUsGuide se simula con su propio corpus (sintético); Knowledge Desk no
// tiene configurado ningún acceso a Pinecone.
const CLAVE = 'clave-sintetica-forusguide-0123456789'
const EJEMPLOS = fileURLToPath(new URL('../../config/ejemplos.json', import.meta.url))

describe('Vista previa pública: ForUsGuide solo consulta, sin indexación', () => {
  let dir: string
  let app: FastifyInstance
  let pinecone: PineconeSimulado
  let forusguide: ForUsGuideSimulado
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kd-forusguide-consulta-'))
    pinecone = await iniciarPineconeSimulado()
    forusguide = await iniciarForUsGuideSimulado({ pinecone, apiKey: CLAVE })
    // Corpus PROPIO de ForUsGuide (simulado): Knowledge Desk no lo escribe.
    for (const indice of [1, 2]) {
      pinecone.registros.set(`retiros_401k_chunk_${indice}`, {
        _id: `retiros_401k_chunk_${indice}`,
        content: indice === 1 ? 'Para hacer un retiro de tu 401(k) se solicita el retiro en el portal del plan.' : 'El retiro de un 401(k) puede tener impuestos y penalidades.',
        article_id: 'retiros_401k', article_title: 'Retiros de un 401(k) (sintético)', chunk_type: 'steps', chunk_tier: 'high', chunk_index: indice, visibleDesde: 0,
      })
    }
    const config = loadConfig({
      KD_MODO: 'forusguide', FORUSGUIDE_API_URL: forusguide.url, FORUSGUIDE_API_KEY: CLAVE,
      KD_HOST: '0.0.0.0', KD_ACCESO_PUBLICO: 'true', KD_DATOS_TEMPORALES: 'true', KD_MAX_ARTICULO_MB: '10',
      KD_DATA_DIR: path.join(dir, 'datos'), KD_UI_DIST: path.join(dir, 'sin-ui'), KD_EJEMPLOS_ARCHIVO: EJEMPLOS,
    })
    assert.equal(config.pinecone, null)
    app = await construirApp(await construirServicios(config), { logger: false })
  })
  after(async () => {
    await app.close()
    await forusguide.cerrar()
    await pinecone.cerrar()
    await rm(dir, { recursive: true, force: true })
  })

  it('el estado declara consulta con ForUsGuide e indexación no configurada, sin pedir acceso', async () => {
    const respuesta = await app.inject('/api/estado')
    assert.equal(respuesta.statusCode, 200)
    const estado = respuesta.json()
    assert.equal(estado.modo, 'forusguide')
    assert.deepEqual(estado.consulta, { configurada: true, motor: 'forusguide' })
    assert.equal(estado.indexacion.configurada, false)
    assert.deepEqual(estado.faltan, ['PINECONE_API_KEY', 'PINECONE_INDEX_HOST'])
    assert.equal(estado.accesoControlado, false)
    assert.equal(estado.puedeAdministrar, true)
  })

  it('la consulta usa ForUsGuide con la clave del servidor y abre la fuente externa como fragmentos indexados', async () => {
    const respuesta = await app.inject({ method: 'POST', url: '/api/consulta', payload: { question: '¿Cómo hago un retiro de mi 401(k)?' } })
    assert.equal(respuesta.statusCode, 200)
    const contrato = respuesta.json()
    assert.equal(contrato.outcome, 'answered')
    assert.equal(contrato.engine, 'forusguide')
    const fuente = contrato.sources[0]
    assert.equal(fuente.kind, 'external_article')
    assert.equal(fuente.href, '/fuentes/retiros_401k')
    const llamada = forusguide.recibidas.find(item => item.ruta === '/api/v1/knowledge-question')!
    assert.equal(llamada.cabeceras['x-api-key'], CLAVE)
    assert.deepEqual(llamada.cuerpo, { question: '¿Cómo hago un retiro de mi 401(k)?' })
    assert.doesNotMatch(respuesta.body, new RegExp(CLAVE))

    const articulo = (await app.inject('/api/fuentes/retiros_401k')).json()
    assert.equal(articulo.tipo, 'articulo_externo')
    assert.equal(articulo.origen, 'fragmentos_indexados')
    assert.deepEqual(articulo.fragmentos.map((fragmento: { indice: number }) => fragmento.indice), [1, 2])
  })

  it('no se puede cargar ningún artículo y Knowledge Desk no hace ninguna petición a Pinecone', async () => {
    const archivo = multipart('Intento.json', json(articuloSimple('intento_publico', 'Intento', 'Texto suficiente para indexar un artículo de prueba en el índice.')))
    const carga = await app.inject({ method: 'POST', url: '/api/documentos', ...archivo })
    assert.equal(carga.statusCode, 503)
    assert.equal(carga.json().code, 'INDEX_NOT_CONFIGURED')
    assert.deepEqual((await app.inject('/api/documentos')).json().documentos, [])
    assert.equal(pinecone.peticiones.length, 0)
  })

  it('los ejemplos de ForUsGuide se muestran sin verificar contra el índice (sin acceso de lectura configurado)', async () => {
    const ejemplos = (await app.inject('/api/ejemplos')).json()
    assert.equal(ejemplos.verified, false)
    assert.equal(ejemplos.examples[0], '¿Cómo hago un retiro de mi 401(k)?')
    assert.deepEqual(ejemplos.rejected, [])
  })
})

describe('La vista pública nunca escribe en el índice compartido de ForUsGuide', () => {
  it('KD_ACCESO_PUBLICO=true con KD_MODO=forusguide y PINECONE_* impide arrancar; sin acceso público sigue permitido', () => {
    const base = { KD_MODO: 'forusguide', FORUSGUIDE_API_URL: 'https://forusguide.invalid', KD_HOST: '0.0.0.0' }
    for (const extra of [{ PINECONE_API_KEY: 'sintetica' }, { PINECONE_INDEX_HOST: 'https://indice.invalid' }]) {
      assert.throws(() => loadConfig({ ...base, KD_ACCESO_PUBLICO: 'true', ...extra }), /solo consulta y no escribe en el índice compartido/)
    }
    const controlado = loadConfig({ ...base, KD_ACCESO_BASICO: 'piloto:clave-de-piloto-segura', PINECONE_API_KEY: 'sintetica', PINECONE_INDEX_HOST: 'https://indice.invalid' })
    assert.ok(controlado.pinecone)
    assert.equal(loadConfig({ ...base, KD_ACCESO_PUBLICO: 'true' }).pinecone, null)
  })
})
