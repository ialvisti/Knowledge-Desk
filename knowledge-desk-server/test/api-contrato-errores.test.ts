import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { construirApp, construirServicios, type Servicios } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'

// HU10 por la API pública (POST /api/consulta y su alias
// POST /api/v1/knowledge-question) con los adaptadores REALES del modo directo:
// el SDK oficial de Pinecone y el cliente OpenAI-compatible de Knowledge Desk.
// Solo se sustituye la red (fetch inyectado), para provocar respuestas y fallos
// de los servicios con CANARIOS en cuerpo, cabeceras, mensaje, causa y stack.

const RUTAS = ['/api/consulta', '/api/v1/knowledge-question'] as const
const CLAVE_PINECONE = 'pcsk_CANARIO_CLAVE_PINECONE_0123456789abcdef'
const CLAVE_LLM = 'sk-CANARIO-CLAVE-LLM-0123456789abcdef'
const HOST_PINECONE = 'https://canario-indice-0123.svc.canario-region.pinecone.io'
const HOST_LLM = 'https://canario-llm.interno.example/v1'
const CANARIOS = [
  CLAVE_PINECONE, CLAVE_LLM, HOST_PINECONE, HOST_LLM, 'canario-indice', 'canario-llm', 'canario-region',
  'CANARIO_CUERPO', 'CANARIO_CABECERA', 'CANARIO_MENSAJE', 'CANARIO_CAUSA', 'CANARIO_STACK', 'CANARIO_TOKEN', 'CANARIO_CONEXION', 'CANARIO_PREGUNTA',
]
// Cadena de conexión y token con forma realista, dentro de los cuerpos externos.
const DETALLE_EXTERNO = `CANARIO_CUERPO postgres://admin:CANARIO_TOKEN@db.interno:5432/kb Bearer ${CLAVE_LLM} api-key=${CLAVE_PINECONE} CANARIO_CONEXION`

type Modo = 'ok' | 'rechazo' | 'caida' | 'red'

function errorConCanarios(): Error {
  const error = new TypeError(`CANARIO_MENSAJE fallo de red hacia ${HOST_PINECONE} con ${CLAVE_PINECONE}`, { cause: new Error(`CANARIO_CAUSA ${DETALLE_EXTERNO}`) })
  error.stack = `TypeError: CANARIO_STACK\n    at conectar (/srv/app/node_modules/interno.js:10:5)\n    at ${HOST_LLM}`
  return error
}

const cabecerasCanario = { 'content-type': 'application/json', 'x-canario': 'CANARIO_CABECERA', 'set-cookie': 'sesion=CANARIO_TOKEN', 'www-authenticate': `Bearer realm="CANARIO_CABECERA" ${CLAVE_PINECONE}` }

function crearRed() {
  const red = {
    pinecone: 'ok' as Modo,
    llm: 'ok' as Modo,
    llamadasPinecone: 0,
    llamadasLlm: 0,
    // Hits que devuelve la búsqueda en el namespace base: un artículo con dos fragmentos.
    hits: [
      { _id: 'licencias_guia_chunk_1', _score: 0.71, fields: { article_id: 'licencias_guia', article_title: 'Guía de licencias', chunk_type: 'eligibility', chunk_index: 1, content: 'Pueden solicitar la licencia los colaboradores con contrato vigente.' } },
      { _id: 'licencias_guia_chunk_2', _score: 0.64, fields: { article_id: 'licencias_guia', article_title: 'Guía de licencias', chunk_type: 'business_rules', chunk_index: 2, content: 'La solicitud debe presentarse con 10 días hábiles de anticipación.' } },
    ],
    fetchPinecone: (async (input: string | URL | Request) => {
      red.llamadasPinecone++
      const url = String(input instanceof Request ? input.url : input)
      if (red.pinecone === 'red') throw errorConCanarios()
      if (red.pinecone === 'rechazo') return new Response(JSON.stringify({ error: { code: 'INVALID_ARGUMENT', message: DETALLE_EXTERNO } }), { status: 400, headers: cabecerasCanario })
      if (red.pinecone === 'caida') return new Response(JSON.stringify({ error: { code: 'UNAVAILABLE', message: DETALLE_EXTERNO } }), { status: 503, headers: cabecerasCanario })
      const hits = url.includes('/namespaces/kb_articles/') ? red.hits : []
      return Response.json({ result: { hits }, usage: { read_units: 1 } })
    }) as typeof fetch,
    fetchLlm: (async (_input: string | URL | Request, init?: RequestInit) => {
      red.llamadasLlm++
      if (red.llm === 'red') throw errorConCanarios()
      if (red.llm !== 'ok') return new Response(JSON.stringify({ error: { message: DETALLE_EXTERNO, type: 'CANARIO_CUERPO' } }), { status: red.llm === 'rechazo' ? 401 : 503, headers: cabecerasCanario })
      const cuerpo = JSON.parse(String(init?.body ?? '{}')) as { messages: { content: string }[] }
      const salida = cuerpo.messages[0].content.startsWith('You are a query decomposition')
        ? { sub_queries: [] }
        : { respuesta: 'Pueden solicitar la licencia los colaboradores con contrato vigente [1]. La solicitud se presenta con 10 días hábiles de anticipación [2].', puntos_clave: [{ texto: 'Contrato vigente.', fuentes: [1] }, { texto: '10 días hábiles de anticipación.', fuentes: [2] }], vacios_de_cobertura: [], contradicciones: [] }
      return Response.json({ choices: [{ message: { content: JSON.stringify(salida) } }] })
    }) as typeof fetch,
  }
  return red
}

// Todo texto público de una respuesta: cuerpo crudo, cada cadena del JSON y
// cada cabecera.
function textosPublicos(respuesta: LightMyRequestResponse): string[] {
  const textos = [respuesta.body, ...Object.entries(respuesta.headers).map(([clave, valor]) => `${clave}: ${String(valor)}`)]
  const recorrer = (valor: unknown) => {
    if (typeof valor === 'string') textos.push(valor)
    else if (Array.isArray(valor)) valor.forEach(recorrer)
    else if (valor && typeof valor === 'object') Object.entries(valor).forEach(([clave, item]) => { textos.push(clave); recorrer(item) })
  }
  try { recorrer(JSON.parse(respuesta.body)) } catch { /* el cuerpo crudo ya está incluido */ }
  return textos
}

function exigirSinFugas(respuesta: LightMyRequestResponse, contexto: string) {
  for (const texto of textosPublicos(respuesta)) {
    for (const canario of CANARIOS) assert.ok(!texto.includes(canario), `${contexto}: el canario "${canario}" aparece en "${texto.slice(0, 120)}"`)
    assert.doesNotMatch(texto, /\n\s+at\s|node_modules|\/srv\/|[A-Za-z]+Error\b|postgres:\/\/|Bearer\s|api-key/i, `${contexto}: traza o dato interno en "${texto.slice(0, 120)}"`)
  }
}

describe('HU10 · contrato y errores de la API con adaptadores reales', () => {
  let dir: string
  let red: ReturnType<typeof crearRed>
  let servicios: Servicios
  let app: FastifyInstance

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kd-api-'))
    await writeFile(path.join(dir, 'ejemplos.json'), JSON.stringify({ directo: [] }))
  })
  beforeEach(async () => {
    await app?.close()
    red = crearRed()
    const config = loadConfig({
      KD_MODO: 'directo', PINECONE_API_KEY: CLAVE_PINECONE, PINECONE_INDEX_HOST: HOST_PINECONE, PINECONE_NAMESPACE: 'kb_articles',
      KD_LLM_BASE_URL: HOST_LLM, KD_LLM_API_KEY: CLAVE_LLM, KD_CHAT_MODEL: 'gpt-simulado',
      KD_DATA_DIR: path.join(dir, 'datos'), KD_UI_DIST: path.join(dir, 'sin-ui'), KD_EJEMPLOS_ARCHIVO: path.join(dir, 'ejemplos.json'),
    })
    servicios = await construirServicios(config, { fetchPinecone: red.fetchPinecone, fetchProveedor: red.fetchLlm, pineconeMaxRetries: 0 })
    app = await construirApp(servicios, { logger: false })
  })
  after(async () => {
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  })

  // CP-HU10-01
  it('CP-HU10-01 · pregunta válida: answer, key_points, sources, coverage y status coherentes en ambas rutas', async () => {
    const claves: string[][] = []
    for (const url of RUTAS) {
      const respuesta = await app.inject({ method: 'POST', url, payload: { question: '¿Quiénes pueden solicitar la licencia?' } })
      assert.equal(respuesta.statusCode, 200, url)
      const cuerpo = respuesta.json()
      claves.push(Object.keys(cuerpo).sort())
      assert.equal(cuerpo.status, 'ok')
      assert.equal(cuerpo.request_id, respuesta.headers['x-request-id'])
      assert.equal(cuerpo.question, '¿Quiénes pueden solicitar la licencia?')
      assert.equal(cuerpo.outcome, 'answered')
      assert.equal(cuerpo.engine, 'directo')
      // Respuesta directa y puntos relevantes, sin las citas internas [n].
      assert.equal(typeof cuerpo.answer, 'string')
      assert.match(cuerpo.answer, /contrato vigente/)
      assert.doesNotMatch(cuerpo.answer, /\[\d\]/)
      assert.deepEqual(cuerpo.key_points, ['Contrato vigente.', '10 días hábiles de anticipación.'])
      // Cobertura coherente con la evidencia (HU05).
      assert.equal(cuerpo.coverage.level, 'alta')
      assert.equal(cuerpo.coverage.sufficient, true)
      assert.equal(cuerpo.coverage.policy, 'kd-cobertura-v1')
      assert.equal(cuerpo.coverage.relevant_fragments, 2)
      // Fuentes NO vacías y asociadas a los fragmentos realmente recuperados (HU04).
      assert.equal(cuerpo.sources.length, 1)
      const fuente = cuerpo.sources[0]
      assert.equal(fuente.id, 'licencias_guia')
      assert.equal(fuente.article_id, 'licencias_guia')
      assert.equal(fuente.title, 'Guía de licencias')
      assert.equal(fuente.kind, 'external_article')
      assert.equal(fuente.href, '/fuentes/licencias_guia')
      assert.equal(fuente.affinity, 0.71)
      assert.equal(fuente.fragment_count, 2)
      assert.deepEqual(fuente.fragments.map((item: { id: string; affinity: number; type: string; content: string }) => [item.id, item.affinity, item.type, item.content]),
        red.hits.map(hit => [hit._id, Math.round(hit._score * 100) / 100, hit.fields.chunk_type, hit.fields.content]))
      assert.deepEqual(cuerpo.found_documents, [])
      assert.deepEqual(cuerpo.contradictions, [])
      assert.equal(cuerpo.retrieval.generated, true)
      assert.equal(cuerpo.retrieval.model, 'gpt-simulado')
      assert.equal(typeof cuerpo.elapsed_ms, 'number')
      assert.equal(typeof cuerpo.corpus_revision, 'number')
      exigirSinFugas(respuesta, `éxito ${url}`)
    }
    assert.deepEqual(claves[0], claves[1], 'mismo contrato en ambas rutas')
  })

  // CP-HU10-02
  it('CP-HU10-02 · vacía, solo espacios, nula y omitida: 422 en ambas rutas, sin recuperar ni generar', async () => {
    const entradas: [string, unknown][] = [['vacía', { question: '' }], ['espacios', { question: '   \t  ' }], ['nula', { question: null }], ['omitida', {}]]
    for (const url of RUTAS) {
      for (const [nombre, payload] of entradas) {
        const respuesta = await app.inject({ method: 'POST', url, payload: payload as object })
        assert.equal(respuesta.statusCode, 422, `${url} ${nombre}`)
        const cuerpo = respuesta.json()
        assert.equal(cuerpo.status, 'error')
        assert.equal(cuerpo.code, 'VALIDATION_ERROR', `${url} ${nombre}`)
        assert.equal(cuerpo.details.retryable, false)
        assert.match(cuerpo.details.motivo, nombre === 'nula' || nombre === 'omitida' ? /^formato$/ : /^vacia$/)
        assert.equal(cuerpo.request_id, respuesta.headers['x-request-id'])
      }
    }
    assert.equal(red.llamadasPinecone, 0, 'ninguna recuperación')
    assert.equal(red.llamadasLlm, 0, 'ninguna generación')
  })

  // CP-HU10-07
  it('CP-HU10-07 · validación: el error no repite la pregunta ni datos internos', async () => {
    for (const url of RUTAS) {
      const larga = await app.inject({ method: 'POST', url, payload: { question: `CANARIO_PREGUNTA ${CLAVE_LLM} ${'x'.repeat(120)}` } })
      assert.equal(larga.json().code, 'VALIDATION_ERROR')
      exigirSinFugas(larga, `validación larga ${url}`)
      const malformado = await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: `{"question": "CANARIO_PREGUNTA ${CLAVE_PINECONE}"` })
      assert.equal(malformado.json().code, 'VALIDATION_ERROR')
      exigirSinFugas(malformado, `validación malformada ${url}`)
    }
    assert.equal(red.llamadasPinecone + red.llamadasLlm, 0)
  })

  const fallos: { nombre: string; preparar: (r: ReturnType<typeof crearRed>) => void; status: number; code: string }[] = [
    { nombre: 'recuperación (Pinecone rechaza la búsqueda, 400)', preparar: r => { r.pinecone = 'rechazo' }, status: 502, code: 'RETRIEVAL_ERROR' },
    { nombre: 'base vectorial (Pinecone no disponible, 503)', preparar: r => { r.pinecone = 'caida' }, status: 503, code: 'VECTOR_DB_UNAVAILABLE' },
    { nombre: 'base vectorial (fallo de red con mensaje, causa y stack)', preparar: r => { r.pinecone = 'red' }, status: 503, code: 'VECTOR_DB_UNAVAILABLE' },
    { nombre: 'IA (el proveedor rechaza la credencial, 401)', preparar: r => { r.llm = 'rechazo' }, status: 502, code: 'AI_PROVIDER_ERROR' },
    { nombre: 'IA (el proveedor falla, 503)', preparar: r => { r.llm = 'caida' }, status: 502, code: 'AI_PROVIDER_ERROR' },
    { nombre: 'IA (fallo de red con mensaje, causa y stack)', preparar: r => { r.llm = 'red' }, status: 502, code: 'AI_PROVIDER_ERROR' },
  ]
  for (const fallo of fallos) {
    it(`CP-HU10-07 · ${fallo.nombre}: ${fallo.code} sin claves, tokens, conexiones ni trazas`, async () => {
      fallo.preparar(red)
      for (const url of RUTAS) {
        const respuesta = await app.inject({ method: 'POST', url, payload: { question: '¿Quiénes pueden solicitar la licencia?' } })
        assert.equal(respuesta.statusCode, fallo.status, url)
        const cuerpo = respuesta.json()
        assert.deepEqual(Object.keys(cuerpo).sort(), ['code', 'details', 'message', 'request_id', 'status'])
        assert.equal(cuerpo.status, 'error')
        assert.equal(cuerpo.code, fallo.code)
        assert.equal(cuerpo.details.retryable, true)
        exigirSinFugas(respuesta, `${fallo.nombre} ${url}`)
      }
      // El fallo ocurrió de verdad en el adaptador correspondiente.
      if (red.llm !== 'ok') assert.ok(red.llamadasLlm > 0)
      else assert.ok(red.llamadasPinecone > 0)
    })
  }

  it('CP-HU10-07 · el estado público tampoco expone claves ni hosts', async () => {
    const estado = await app.inject({ method: 'GET', url: '/api/estado' })
    exigirSinFugas(estado, 'estado')
  })
})
