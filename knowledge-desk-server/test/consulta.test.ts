import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { construirApp, construirServicios } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { evaluarCobertura } from '../src/consulta/coverage.ts'
import type { Evidencia, Motor, ResultadoMotor } from '../src/consulta/motor.ts'
import { consultar } from '../src/consulta/service.ts'
import { Registro } from '../src/documents/store.ts'
import { json } from './support/articulos.ts'
import { PREGUNTA_VIATICOS, VIATICOS_V1 } from './support/demo-documentos.ts'
import { CLAVE_PINECONE, CLAVE_SERVIDOR, crearEntorno, type Entorno } from './support/entorno.ts'

const UMBRALES = { minScore: 0.2, altaScore: 0.35, mediaScore: 0.22 }

function evidencia(score: number, extra: Partial<Evidencia> = {}): Evidencia {
  const chunkId = extra.chunkId ?? `art_chunk_${Math.round(score * 1000)}`
  return { chunkId, articleId: 'art', articleTitle: 'Artículo', score, chunkType: 'faqs', content: `Texto del fragmento ${chunkId}`, paths: [], ...extra }
}

describe('HU10 · contrato de la consulta contra ForUsGuide', () => {
  let entorno: Entorno
  before(async () => {
    entorno = await crearEntorno()
    await entorno.subir('Politica_Viaticos_v3.2.json', json(VIATICOS_V1))
    await entorno.servicios.gestor.esperarInactividad()
  })
  after(async () => entorno.cerrar())

  it('valida la pregunta antes de llamar a ningún servicio', async () => {
    const llamadasAntes = entorno.forusguide.recibidas.length
    const casos: [unknown, string][] = [
      [{ question: '' }, 'vacia'], [{ question: '     ' }, 'vacia'], [{ question: 'corta' }, 'corta'],
      [{ question: 'a'.repeat(2001) }, 'larga'], [{}, 'formato'], [{ question: 42 }, 'formato'],
    ]
    for (const [payload, motivo] of casos) {
      const respuesta = await entorno.app.inject({ method: 'POST', url: '/api/consulta', payload: payload as object })
      assert.equal(respuesta.statusCode, 422)
      const cuerpo = respuesta.json()
      assert.equal(cuerpo.status, 'error')
      assert.equal(cuerpo.code, 'VALIDATION_ERROR')
      assert.equal(cuerpo.details.motivo, motivo)
      assert.match(cuerpo.request_id, /^req-[0-9a-f]{8}$/)
      assert.equal(respuesta.headers['x-request-id'], cuerpo.request_id)
    }
    const malformado = await entorno.app.inject({ method: 'POST', url: '/api/consulta', headers: { 'content-type': 'application/json' }, payload: '{no es json' })
    assert.equal(malformado.json().code, 'VALIDATION_ERROR')
    assert.equal(entorno.forusguide.recibidas.length, llamadasAntes)
  })

  it('envía solo la pregunta, inyecta X-API-Key desde el servidor y propaga el ID de correlación', async () => {
    const respuesta = await entorno.app.inject({ method: 'POST', url: '/api/consulta', headers: { 'x-request-id': 'req-0a1b2c3d' }, payload: { question: PREGUNTA_VIATICOS, ticket_id: 'TKT-1', contexto: 'anterior' } })
    assert.equal(respuesta.statusCode, 200)
    const recibida = entorno.forusguide.recibidas.at(-1)!
    assert.equal(recibida.cabeceras['x-api-key'], CLAVE_SERVIDOR)
    assert.equal(recibida.cabeceras['x-correlation-id'], 'req-0a1b2c3d')
    assert.deepEqual(recibida.cuerpo, { question: PREGUNTA_VIATICOS })
    assert.equal(respuesta.json().request_id, 'req-0a1b2c3d')
    assert.doesNotMatch(respuesta.body + JSON.stringify(respuesta.headers), new RegExp(`${CLAVE_SERVIDOR}|${CLAVE_PINECONE}`))
  })

  it('el estado público no expone claves ni direcciones internas', async () => {
    const texto = (await entorno.app.inject('/api/estado')).body
    assert.doesNotMatch(texto, new RegExp(`${CLAVE_SERVIDOR}|${CLAVE_PINECONE}|127\\.0\\.0\\.1|apiKey`))
    assert.equal(JSON.parse(texto).consulta.configurada, true)
  })

  it('la respuesta sustentada trae respuesta, puntos clave, fuentes, cobertura y metadatos de procesamiento', async () => {
    const { cuerpo } = await entorno.preguntar(PREGUNTA_VIATICOS)
    assert.equal(cuerpo.status, 'ok')
    assert.equal(cuerpo.outcome, 'answered')
    assert.ok(cuerpo.answer.length > 0)
    assert.ok(cuerpo.key_points.length > 0)
    assert.ok(['alta', 'parcial'].includes(cuerpo.coverage.level))
    assert.equal(cuerpo.coverage.policy, 'kd-cobertura-v1')
    assert.ok(cuerpo.retrieval.fragments_retrieved > 0)
    assert.equal(cuerpo.retrieval.model, 'simulado')
    for (const fuente of cuerpo.sources) {
      assert.ok(fuente.affinity >= UMBRALES.minScore)
      assert.equal(fuente.fragment_count, fuente.fragments.length)
    }
  })

  it('diferencia validación, recuperación, base vectorial y proveedor de IA sin exponer detalles', async () => {
    const casos: [string, number, string][] = [
      ['retrieval', 502, 'RETRIEVAL_ERROR'],
      ['vector', 503, 'VECTOR_DB_UNAVAILABLE'],
      ['proveedor', 502, 'AI_PROVIDER_ERROR'],
      ['llm_vacio', 502, 'AI_PROVIDER_ERROR'],
      ['no_inicializado', 503, 'VECTOR_DB_UNAVAILABLE'],
      ['error500', 502, 'UPSTREAM_ERROR'],
    ]
    for (const [fallo, status, code] of casos) {
      entorno.forusguide.control.fallo = fallo as never
      const { status: recibido, cuerpo } = await entorno.preguntar(PREGUNTA_VIATICOS)
      assert.equal(recibido, status, fallo)
      assert.equal(cuerpo.code, code, fallo)
      assert.doesNotMatch(JSON.stringify(cuerpo), /internal error occurred|RAG Engine|Unable to generate/)
    }
    entorno.forusguide.control.fallo = null
  })

  it('una credencial rechazada por ForUsGuide se informa como fallo de configuración del servidor', async () => {
    const original = entorno.config.forusguide!.apiKey
    entorno.config.forusguide!.apiKey = 'otra-clave'
    const servicios = await construirServicios(entorno.config, { pineconeMaxRetries: 0 })
    const app = await construirApp(servicios, { logger: false })
    const respuesta = await app.inject({ method: 'POST', url: '/api/consulta', payload: { question: PREGUNTA_VIATICOS } })
    assert.equal(respuesta.json().code, 'UPSTREAM_AUTH_ERROR')
    assert.equal(respuesta.json().details.retryable, false)
    await app.close()
    entorno.config.forusguide!.apiKey = original
  })

  it('el tiempo agotado se informa como TIMEOUT y no presenta ninguna respuesta', async () => {
    const original = entorno.config.consultaTimeoutMs
    entorno.config.consultaTimeoutMs = 150
    entorno.forusguide.control.retrasoMs = 600
    const { status, cuerpo } = await entorno.preguntar(PREGUNTA_VIATICOS)
    entorno.config.consultaTimeoutMs = original
    entorno.forusguide.control.retrasoMs = 0
    assert.equal(status, 504)
    assert.equal(cuerpo.code, 'TIMEOUT')
    assert.equal(cuerpo.answer, undefined)
  })

  it('un servicio inalcanzable se informa sin detalles internos', async () => {
    const config = loadConfig({ KD_MODO: 'forusguide', FORUSGUIDE_API_URL: 'http://127.0.0.1:9', KD_DATA_DIR: `${entorno.dataDir}/otro`, KD_UI_DIST: `${entorno.dataDir}/sin-ui` })
    const app = await construirApp(await construirServicios(config), { logger: false })
    const respuesta = await app.inject({ method: 'POST', url: '/api/consulta', payload: { question: PREGUNTA_VIATICOS } })
    assert.equal(respuesta.json().code, 'UPSTREAM_UNREACHABLE')
    assert.doesNotMatch(respuesta.body, /127\.0\.0\.1|ECONNREFUSED/)
    await app.close()
  })
})

describe('HU05 · política de cobertura kd-cobertura-v1', () => {
  it('cobertura alta, límite, baja y ausencia total de evidencia', () => {
    const alta = evaluarCobertura([evidencia(0.6), evidencia(0.5), evidencia(0.45)], null, [], UMBRALES)
    assert.equal(alta.level, 'alta')
    assert.equal(alta.sufficient, true)

    // Límite: exactamente en el umbral de relevancia y en el umbral medio.
    const limite = evaluarCobertura([evidencia(0.22)], null, [], UMBRALES)
    assert.equal(limite.level, 'parcial')
    assert.equal(limite.relevant_fragments, 1)
    const debajo = evaluarCobertura([evidencia(0.2199), evidencia(0.21)], null, [], UMBRALES)
    assert.equal(debajo.level, 'baja')
    assert.equal(debajo.sufficient, false)

    const conVacios = evaluarCobertura([evidencia(0.6), evidencia(0.5)], null, ['plazo', 'monto'], UMBRALES)
    assert.equal(conVacios.level, 'baja')

    const cero = evaluarCobertura([evidencia(0.19), evidencia(0.05)], 'well_covered', [], UMBRALES)
    assert.equal(cero.level, 'sin_evidencia')
    assert.equal(cero.relevant_fragments, 0)
    assert.equal(cero.total_fragments, 2)
  })

  it('respeta el nivel del motor cuando lo calcula y no lo presenta como probabilidad', () => {
    const cobertura = evaluarCobertura([evidencia(0.3)], 'limited_coverage', [], UMBRALES)
    assert.equal(cobertura.level, 'baja')
    assert.equal(cobertura.basis, 'motor')
    assert.doesNotMatch(JSON.stringify(cobertura), /%|probab/i)
  })
})

describe('HU03–HU05 · presentación según la evidencia', () => {
  function motorCon(resultado: Partial<ResultadoMotor>): Motor {
    return {
      nombre: 'local',
      preguntar: async () => ({
        motor: 'local', respuesta: 'Texto [1]', puntosClave: ['Punto'], evidencia: [], nivelMotor: null, vaciosCobertura: [],
        contradicciones: [], modelo: 'm', subconsultas: [], fragmentosRecuperados: 0, articulosConsultados: 0, generada: true, ...resultado,
      }),
    }
  }
  // Registro vacío en memoria: no se carga ni se escribe en disco.
  const registro = new Registro(path.join(os.tmpdir(), 'kd-registro-sin-cargar'))
  const deps = (motor: Motor) => ({ motor, registro, umbrales: UMBRALES, timeoutMs: 5000 })

  it('con cobertura insuficiente no presenta la respuesta generada ni referencias como sustento', async () => {
    const contrato = await consultar(deps(motorCon({ evidencia: [evidencia(0.21), evidencia(0.2)], respuesta: 'Afirmación del modelo' })), { question: PREGUNTA_VIATICOS }, 'req-00000001')
    assert.equal(contrato.outcome, 'insufficient')
    assert.equal(contrato.answer, null)
    assert.deepEqual(contrato.key_points, [])
    assert.deepEqual(contrato.sources, [])
    assert.equal(contrato.found_documents.length, 1)
  })

  it('las fuentes son solo artículos con fragmentos usados sobre el umbral; los descartados no aparecen', async () => {
    const contrato = await consultar(deps(motorCon({
      evidencia: [
        evidencia(0.6, { chunkId: 'a_chunk_1', articleId: 'a', articleTitle: 'A' }),
        evidencia(0.5, { chunkId: 'a_chunk_2', articleId: 'a', articleTitle: 'A', chunkType: 'decision_guide' }),
        evidencia(0.45, { chunkId: 'b_chunk_1', articleId: 'b', articleTitle: 'B' }),
        evidencia(0.1, { chunkId: 'c_chunk_1', articleId: 'c', articleTitle: 'Descartado' }),
        evidencia(0.6, { chunkId: 'a_chunk_1', articleId: 'a', articleTitle: 'A' }),
      ],
    })), { question: PREGUNTA_VIATICOS }, 'req-00000002')
    assert.deepEqual(contrato.sources.map(fuente => [fuente.title, fuente.fragment_count]), [['A', 2], ['B', 1]])
    assert.equal(contrato.sources[0].fragments[1].operational, true)
    assert.equal(contrato.sources[0].kind, 'external_article')
    assert.equal(contrato.coverage.total_fragments, 4)
  })

  it('el mismo texto de un artículo en dos fragmentos (eligibility y business_rules) cuenta una vez', async () => {
    const regla = '# Business Rules: Eligibility\n\n## Eligibility:\n- Solo cuentas activas.'
    const contrato = await consultar(deps(motorCon({
      evidencia: [
        evidencia(0.6, { chunkId: 'a_chunk_1', articleId: 'a', chunkType: 'eligibility', content: regla }),
        evidencia(0.58, { chunkId: 'a_chunk_4', articleId: 'a', chunkType: 'business_rules', content: regla }),
        evidencia(0.5, { chunkId: 'b_chunk_1', articleId: 'b', content: regla }),
      ],
    })), { question: PREGUNTA_VIATICOS }, 'req-00000005')
    assert.deepEqual(contrato.sources.map(fuente => [fuente.id, fuente.fragments.map(fragmento => fragmento.id)]), [['a', ['a_chunk_1']], ['b', ['b_chunk_1']]])
    assert.equal(contrato.coverage.total_fragments, 2)
  })

  it('una respuesta sin citas al contexto no se presenta como sustentada', async () => {
    const contrato = await consultar(deps(motorCon({ evidencia: [evidencia(0.6), evidencia(0.5)], sinSustento: true })), { question: PREGUNTA_VIATICOS }, 'req-00000003')
    assert.equal(contrato.outcome, 'insufficient')
    assert.equal(contrato.coverage.level, 'baja')
  })

  it('las contradicciones se entregan junto a las fuentes para revisión humana', async () => {
    const contrato = await consultar(deps(motorCon({
      evidencia: [evidencia(0.6, { articleId: 'a', chunkId: 'a_chunk_1' }), evidencia(0.55, { articleId: 'b', chunkId: 'b_chunk_1' })],
      contradicciones: [{ descripcion: 'A fija 15 días y B fija 10 días', articleIds: ['a', 'b'] }],
    })), { question: PREGUNTA_VIATICOS }, 'req-00000004')
    assert.deepEqual(contrato.contradictions, [{ description: 'A fija 15 días y B fija 10 días', source_ids: ['a', 'b'] }])
  })

  it('sin motor configurado informa INTEGRATION_NOT_CONFIGURED y nunca inventa una respuesta', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kd-sin-config-'))
    const config = loadConfig({ KD_DATA_DIR: dir, KD_UI_DIST: path.join(dir, 'sin-ui') })
    const app = await construirApp(await construirServicios(config), { logger: false })
    const consulta = await app.inject({ method: 'POST', url: '/api/consulta', payload: { question: PREGUNTA_VIATICOS } })
    assert.equal(consulta.statusCode, 503)
    assert.equal(consulta.json().code, 'INTEGRATION_NOT_CONFIGURED')
    const estado = (await app.inject('/api/estado')).json()
    assert.equal(estado.modo, 'sin_configurar')
    assert.deepEqual(estado.faltan, ['KD_MODO'])
    await app.close()
    await rm(dir, { recursive: true, force: true })
  })
})
