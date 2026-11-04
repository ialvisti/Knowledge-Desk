import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { construirApp, construirServicios, type Servicios } from '../src/app.ts'
import { capacidades, ConfigError, loadConfig } from '../src/config.ts'
import { crearIndicePinecone } from '../src/index/pinecone.ts'
import { IndiceError } from '../src/index/types.ts'
import { articuloSimple, json } from './support/articulos.ts'
import { multipart } from './support/entorno.ts'
import { iniciarPineconeSimulado, type PineconeSimulado } from './support/pinecone-simulado.ts'

// Modo directo: el pipeline knowledge-question sin ForUsGuide. Pinecone se
// simula con sus rutas reales (búsqueda de texto con embeddings integrados) y
// el proveedor OpenAI-compatible con un fetch inyectable. No hay ningún
// FORUSGUIDE_* configurado: cualquier llamada a ForUsGuide fallaría.
const CLAVE_PINECONE = 'pinecone-sintetica-directo-0123456789'
const CLAVE_LLM = 'llm-sintetica-directo-0123456789'

interface LlamadaLlm { ruta: string; cuerpo: Record<string, any>; autorizacion: string | null }

function crearLlmSimulado() {
  const estado = {
    llamadas: [] as LlamadaLlm[],
    subconsultas: ['hardship withdrawal eligibility immediate heavy financial need'] as unknown,
    // Respuesta de redacción: por defecto cita las dos primeras secciones.
    redaccion: (): unknown => ({
      respuesta: 'A hardship withdrawal covers an immediate and heavy financial need [1]. The plan must allow it and the reason must be IRS-approved [2].',
      puntos_clave: [{ texto: 'Only for an immediate and heavy financial need.', fuentes: [1] }],
      vacios_de_cobertura: [],
      contradicciones: [],
    }),
    fallar: null as null | 'descomposicion' | 'redaccion',
    colgar: false,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const ruta = new URL(String(input)).pathname
      const cuerpo = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>
      const cabeceras = new Headers(init?.headers)
      estado.llamadas.push({ ruta, cuerpo, autorizacion: cabeceras.get('authorization') })
      if (estado.colgar) {
        await new Promise((_resolver, rechazar) => init?.signal?.addEventListener('abort', () => rechazar(new DOMException('aborted', 'AbortError'))))
      }
      const esDescomposicion = String(cuerpo.messages?.[0]?.content ?? '').startsWith('You are a query decomposition')
      if ((estado.fallar === 'descomposicion' && esDescomposicion) || (estado.fallar === 'redaccion' && !esDescomposicion)) {
        return Response.json({ error: { message: 'fallo simulado' } }, { status: 500 })
      }
      const salida = esDescomposicion ? { sub_queries: estado.subconsultas } : estado.redaccion()
      return Response.json({ choices: [{ message: { content: JSON.stringify(salida) } }] })
    }) as typeof fetch,
  }
  return estado
}

function sembrar(pinecone: PineconeSimulado) {
  const fragmentos = [
    ['business_rules', 'Hardship withdrawal rules: a hardship withdrawal requires an immediate and heavy financial need and the plan must allow hardship withdrawals.'],
    ['eligibility', 'Hardship withdrawal eligibility: who qualifies for a hardship withdrawal depends on an IRS-approved reason and an immediate heavy financial need.'],
    ['steps', 'Hardship withdrawal steps: request the hardship withdrawal in the portal and upload documentation of the financial need.'],
  ] as const
  fragmentos.forEach(([tipo, contenido], indice) => {
    const id = `hardship_guide_chunk_${indice + 1}`
    pinecone.registros.set(id, { _id: id, content: contenido, article_id: 'hardship_guide', article_title: 'Hardship withdrawal guide (synthetic)', chunk_type: tipo, chunk_index: indice + 1, visibleDesde: 0 })
  })
}

const MUTACIONES = /\/(upsert|delete)$|\/vectors\/list$/

describe('Modo directo · knowledge-question con Pinecone y LLM, sin ForUsGuide', () => {
  let dir: string
  let pinecone: PineconeSimulado
  let llm: ReturnType<typeof crearLlmSimulado>
  let servicios: Servicios
  let app: FastifyInstance

  function entorno(extra: Record<string, string> = {}) {
    return {
      KD_MODO: 'directo',
      PINECONE_API_KEY: CLAVE_PINECONE, PINECONE_INDEX_HOST: pinecone.url, PINECONE_NAMESPACE: 'kb_articles',
      KD_LLM_BASE_URL: 'http://llm.simulado/v1', KD_LLM_API_KEY: CLAVE_LLM, KD_CHAT_MODEL: 'gpt-simulado',
      KD_DATA_DIR: path.join(dir, 'datos'), KD_UI_DIST: path.join(dir, 'sin-ui'), KD_EJEMPLOS_ARCHIVO: path.join(dir, 'ejemplos.json'),
      ...extra,
    }
  }

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kd-directo-'))
    await writeFile(path.join(dir, 'ejemplos.json'), JSON.stringify({ directo: [] }))
    pinecone = await iniciarPineconeSimulado()
    sembrar(pinecone)
  })
  beforeEach(async () => {
    llm = crearLlmSimulado()
    pinecone.peticiones.length = 0
    pinecone.fallos.caido = false
    servicios = await construirServicios(loadConfig(entorno({ KD_HOST: '0.0.0.0', KD_ACCESO_PUBLICO: 'true' })), { fetchProveedor: llm.fetch, pineconeMaxRetries: 0 })
    app = await construirApp(servicios, { logger: false })
  })
  after(async () => {
    await app?.close()
    await pinecone.cerrar()
    await rm(dir, { recursive: true, force: true })
  })

  const preguntar = async (question: string, url = '/api/consulta') => {
    const respuesta = await app.inject({ method: 'POST', url, payload: { question } })
    return { status: respuesta.statusCode, cuerpo: respuesta.json() }
  }

  it('arranca y responde salud sin consultar Pinecone ni el LLM', async () => {
    const salud = await app.inject({ method: 'GET', url: '/api/salud' })
    assert.equal(salud.statusCode, 200)
    assert.equal(pinecone.peticiones.length, 0)
    assert.equal(llm.llamadas.length, 0)
  })

  it('responde con fuentes y cobertura combinando búsqueda de texto y redacción', async () => {
    const { status, cuerpo } = await preguntar('What is a hardship withdrawal and who qualifies?')
    assert.equal(status, 200)
    assert.equal(cuerpo.engine, 'directo')
    assert.equal(cuerpo.outcome, 'answered')
    assert.match(cuerpo.answer, /immediate and heavy financial need/)
    assert.doesNotMatch(cuerpo.answer, /\[\d\]/, 'las citas internas se quitan del texto')
    assert.equal(cuerpo.coverage.policy, 'kd-cobertura-v1')
    assert.equal(cuerpo.coverage.sufficient, true)
    assert.equal(cuerpo.sources.length, 1)
    assert.equal(cuerpo.sources[0].id, 'hardship_guide')
    assert.equal(cuerpo.sources[0].kind, 'external_article')
    assert.deepEqual(cuerpo.retrieval.sub_queries, ['hardship withdrawal eligibility immediate heavy financial need'])
    assert.equal(cuerpo.retrieval.model, 'gpt-simulado')

    // Dos búsquedas de texto (pregunta + subconsulta), nada más en Pinecone.
    const busquedas = pinecone.peticiones.filter(item => item.ruta === '/records/namespaces/kb_articles/search')
    assert.equal(busquedas.length, 2)
    assert.equal(pinecone.peticiones.length, 2)
    // Descomposición y redacción por chat; ningún embedding externo.
    assert.deepEqual(llm.llamadas.map(item => item.ruta), ['/v1/chat/completions', '/v1/chat/completions'])
    assert.ok(llm.llamadas.every(item => item.autorizacion === `Bearer ${CLAVE_LLM}`))
    // Los modelos de razonamiento rechazan temperature: en directo no se envía.
    assert.ok(llm.llamadas.every(item => !('temperature' in item.cuerpo)))
    assert.ok(llm.llamadas.every(item => item.cuerpo.response_format?.type === 'json_object'))
  })

  it('/api/v1/knowledge-question es un alias con la misma validación y contrato', async () => {
    const { status, cuerpo } = await preguntar('What is a hardship withdrawal and who qualifies?', '/api/v1/knowledge-question')
    assert.equal(status, 200)
    assert.equal(cuerpo.outcome, 'answered')
    assert.equal(cuerpo.sources[0].id, 'hardship_guide')
    const corta = await preguntar('corta', '/api/v1/knowledge-question')
    assert.equal(corta.status, 422)
    assert.equal(corta.cuerpo.code, 'VALIDATION_ERROR')
    const larga = await preguntar('x'.repeat(101), '/api/v1/knowledge-question')
    assert.equal(larga.status, 422)
    const formato = await app.inject({ method: 'POST', url: '/api/v1/knowledge-question', headers: { 'content-type': 'text/plain' }, payload: 'hola' })
    assert.equal(formato.json().code, 'VALIDATION_ERROR')
    assert.equal(llm.llamadas.length, 2, 'las preguntas no válidas no llegan al modelo')
  })

  it('si ningún fragmento relevante cabe en el presupuesto no pide redacción', async () => {
    const id = 'hardship_largo_chunk_1'
    // Relevante (comparte términos con la pregunta) pero más largo que los 16000 caracteres del contexto.
    const contenido = `Hardship withdrawal qualifies financial need. ${'x'.repeat(16_100)}`
    const previos = new Map(pinecone.registros)
    pinecone.registros.clear()
    pinecone.registros.set(id, { _id: id, content: contenido, article_id: 'hardship_largo', article_title: 'Largo', chunk_type: 'business_rules', chunk_index: 1, visibleDesde: 0 })
    llm.subconsultas = []
    try {
      const { status, cuerpo } = await preguntar('What is a hardship withdrawal and who qualifies?')
      assert.equal(status, 200)
      assert.ok(cuerpo.retrieval.fragments_retrieved >= 1, 'el fragmento se recuperó')
      assert.equal(cuerpo.outcome, 'insufficient')
      assert.equal(cuerpo.answer, null)
      assert.equal(cuerpo.retrieval.generated, false)
      const redacciones = llm.llamadas.filter(item => !String(item.cuerpo.messages?.[0]?.content ?? '').startsWith('You are a query decomposition'))
      assert.equal(redacciones.length, 0)
    } finally {
      pinecone.registros.clear()
      for (const [clave, valor] of previos) pinecone.registros.set(clave, valor)
    }
  })

  it('sin evidencia relevante no pide redacción al modelo', async () => {
    llm.subconsultas = []
    const { status, cuerpo } = await preguntar('¿Cuál es el horario del comedor central?')
    assert.equal(status, 200)
    assert.equal(cuerpo.outcome, 'insufficient')
    assert.equal(cuerpo.coverage.level, 'sin_evidencia')
    assert.equal(cuerpo.retrieval.generated, false)
    assert.equal(llm.llamadas.length, 1, 'solo la descomposición')
  })

  it('una respuesta sin citas no se presenta como sustentada', async () => {
    llm.redaccion = () => ({ respuesta: 'A hardship withdrawal is always available to everyone.', puntos_clave: [], vacios_de_cobertura: [], contradicciones: [] })
    const { cuerpo } = await preguntar('What is a hardship withdrawal and who qualifies?')
    assert.equal(cuerpo.outcome, 'insufficient')
    assert.equal(cuerpo.answer, null)
    assert.match(cuerpo.coverage.explanation, /sin cita/)
  })

  it('si falla la descomposición busca con la pregunta original', async () => {
    llm.fallar = 'descomposicion'
    const { cuerpo } = await preguntar('What is a hardship withdrawal and who qualifies?')
    assert.equal(cuerpo.outcome, 'answered')
    assert.deepEqual(cuerpo.retrieval.sub_queries, [])
    assert.equal(pinecone.peticiones.length, 1)
  })

  it('un rechazo del proveedor en la redacción es AI_PROVIDER_ERROR', async () => {
    llm.fallar = 'redaccion'
    const { status, cuerpo } = await preguntar('What is a hardship withdrawal and who qualifies?')
    assert.equal(status, 502)
    assert.equal(cuerpo.code, 'AI_PROVIDER_ERROR')
  })

  it('Pinecone no disponible es VECTOR_DB_UNAVAILABLE y no llega a redactar', async () => {
    pinecone.fallos.caido = true
    const { status, cuerpo } = await preguntar('What is a hardship withdrawal and who qualifies?')
    assert.equal(status, 503)
    assert.equal(cuerpo.code, 'VECTOR_DB_UNAVAILABLE')
    assert.equal(llm.llamadas.length, 1)
  })

  it('el tiempo máximo corta la consulta con TIMEOUT', async () => {
    await app.close()
    const config = loadConfig(entorno())
    config.consultaTimeoutMs = 150
    servicios = await construirServicios(config, { fetchProveedor: llm.fetch, pineconeMaxRetries: 0 })
    app = await construirApp(servicios, { logger: false })
    llm.colgar = true
    const { status, cuerpo } = await preguntar('What is a hardship withdrawal and who qualifies?')
    assert.equal(status, 504)
    assert.equal(cuerpo.code, 'TIMEOUT')
  })

  it('la fuente externa se abre con sus fragmentos indexados, ordenados', async () => {
    const respuesta = await app.inject({ method: 'GET', url: '/api/fuentes/hardship_guide' })
    assert.equal(respuesta.statusCode, 200)
    const cuerpo = respuesta.json()
    assert.equal(cuerpo.tipo, 'articulo_externo')
    assert.deepEqual(cuerpo.fragmentos.map((item: { indice: number }) => item.indice), [1, 2, 3])
    assert.ok(pinecone.peticiones.every(item => !MUTACIONES.test(item.ruta)))
  })

  it('no admite cargas, reemplazos ni eliminaciones y nunca escribe en Pinecone', async () => {
    const carga = await app.inject({ method: 'POST', url: '/api/documentos', ...multipart('a.json', json(articuloSimple('kd_prueba', 'Prueba', 'Texto suficiente para un fragmento de prueba del modo directo.'))) })
    assert.equal(carga.statusCode, 503)
    assert.equal(carga.json().code, 'INDEX_NOT_CONFIGURED')
    const documentos = (await app.inject({ method: 'GET', url: '/api/documentos' })).json()
    assert.equal(documentos.indexacionConfigurada, false)
    assert.ok(pinecone.peticiones.every(item => !MUTACIONES.test(item.ruta)))
  })

  it('el estado no expone claves ni el host de Pinecone', async () => {
    const respuesta = await app.inject({ method: 'GET', url: '/api/estado' })
    const texto = respuesta.body
    assert.equal(respuesta.json().modo, 'directo')
    assert.equal(respuesta.json().consulta.motor, 'directo')
    assert.equal(respuesta.json().indexacion.configurada, false)
    assert.deepEqual(respuesta.json().busqueda, { destino: 'Pinecone · namespace kb_articles', soloLectura: true })
    assert.deepEqual(respuesta.json().faltan, [])
    for (const secreto of [CLAVE_PINECONE, CLAVE_LLM, pinecone.url, 'llm.simulado']) assert.ok(!texto.includes(secreto))
  })
})

describe('Modo directo · adaptador Pinecone de solo lectura', () => {
  it('rechaza upsert, listado y borrado sin hacer ninguna petición', async () => {
    const peticiones: string[] = []
    const indice = crearIndicePinecone({ apiKey: CLAVE_PINECONE, indexHost: 'http://pinecone.simulado', namespace: 'kb_articles' }, {
      soloLectura: true, maxRetries: 0,
      fetchApi: async input => { peticiones.push(String(input)); return Response.json({}) },
    })
    for (const operacion of [
      () => indice.upsert([{ id: 'x', texto: 'y', metadata: {} }]),
      () => indice.listarIds('x'),
      () => indice.eliminar(['x']),
    ]) {
      await assert.rejects(operacion(), (error: unknown) => error instanceof IndiceError && error.tipo === 'solo_lectura')
    }
    assert.deepEqual(peticiones, [])
  })
})

describe('Modo directo · configuración', () => {
  const base = { KD_MODO: 'directo', KD_DATA_DIR: path.join(os.tmpdir(), 'kd-directo-config') }

  it('informa lo que falta sin pedir FORUSGUIDE_* ni modelo de embeddings', () => {
    const config = loadConfig(base)
    assert.deepEqual(capacidades(config), { consulta: false, indexacion: false, faltan: ['PINECONE_API_KEY', 'PINECONE_INDEX_HOST', 'KD_LLM_BASE_URL', 'KD_CHAT_MODEL'] })
    const completa = loadConfig({ ...base, PINECONE_API_KEY: 'k', PINECONE_INDEX_HOST: 'https://indice.example', KD_LLM_BASE_URL: 'https://llm.example/v1', KD_CHAT_MODEL: 'm', KD_EMBEDDINGS_MODEL: 'ignorado' })
    assert.deepEqual(capacidades(completa), { consulta: true, indexacion: false, faltan: [] })
    assert.equal(completa.proveedor?.embeddingModel, '')
    assert.equal(completa.proveedor?.temperatura, null)
    assert.equal(completa.forusguide, null)
    assert.equal(completa.pinecone?.namespace, 'kb_articles')
  })

  it('admite acceso público con las claves de lectura y mantiene el bloqueo en forusguide', () => {
    const publico = { KD_HOST: '0.0.0.0', KD_ACCESO_PUBLICO: 'true', PINECONE_API_KEY: 'k', PINECONE_INDEX_HOST: 'https://indice.example' }
    assert.doesNotThrow(() => loadConfig({ ...base, ...publico }))
    assert.throws(() => loadConfig({ ...base, ...publico, KD_MODO: 'forusguide' }), ConfigError)
  })

  it('el modo local conserva temperature 0', () => {
    const local = loadConfig({ KD_MODO: 'local', KD_LLM_BASE_URL: 'http://127.0.0.1:1/v1', KD_CHAT_MODEL: 'm', KD_EMBEDDINGS_MODEL: 'e' })
    assert.equal(local.proveedor?.temperatura, 0)
    assert.throws(() => loadConfig({ KD_MODO: 'otro' }), /forusguide, local o directo/)
  })
})
