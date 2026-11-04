import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { construirApp, construirServicios, type Servicios } from '../src/app.ts'
import { capacidades, ConfigError, loadConfig } from '../src/config.ts'
import { crearMotorDirecto } from '../src/consulta/directo.ts'
import { PROMPT_SISTEMA } from '../src/consulta/local.ts'
import { consultar } from '../src/consulta/service.ts'
import { Registro } from '../src/documents/store.ts'
import { crearIndicePinecone } from '../src/index/pinecone.ts'
import { IndiceError, type BuscadorCorpus } from '../src/index/types.ts'
import { crearProveedor } from '../src/providers/openaiCompatible.ts'
import { articuloSimple, json } from './support/articulos.ts'
import { multipart } from './support/entorno.ts'
import { crearLlmSimulado, redacciones } from './support/llm-simulado.ts'
import { iniciarPineconeSimulado, type PineconeSimulado } from './support/pinecone-simulado.ts'

// Modo directo: el pipeline knowledge-question sin ForUsGuide. Pinecone se
// simula con sus rutas reales (búsqueda de texto con embeddings integrados) y
// el proveedor OpenAI-compatible con un fetch inyectable. No hay ningún
// FORUSGUIDE_* configurado: cualquier llamada a ForUsGuide fallaría.
const CLAVE_PINECONE = 'pinecone-sintetica-directo-0123456789'
const CLAVE_LLM = 'llm-sintetica-directo-0123456789'

function sembrar(pinecone: PineconeSimulado) {
  const fragmentos = [
    ['business_rules', 'Hardship withdrawal rules: a hardship withdrawal requires an immediate and heavy financial need and the plan must allow hardship withdrawals.'],
    ['eligibility', 'Hardship withdrawal eligibility: who qualifies for a hardship withdrawal depends on an IRS-approved reason and an immediate heavy financial need.'],
    ['steps', 'Hardship withdrawal steps: request the hardship withdrawal in the portal and upload documentation of the financial need.'],
  ] as const
  fragmentos.forEach(([tipo, contenido], indice) => {
    const id = `hardship_guide_chunk_${indice + 1}`
    pinecone.registros.set(id, { _id: id, content: contenido, article_id: 'hardship_guide', article_title: 'Hardship withdrawal guide (synthetic)', chunk_type: tipo, chunk_index: indice + 1, visibleDesde: 0, __ns: 'kb_articles' })
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

    // Pregunta + subconsulta, cada una en el corpus base y en los documentos de
    // Knowledge Desk: cuatro búsquedas de texto, nada más en Pinecone.
    assert.equal(pinecone.peticiones.filter(item => item.ruta === '/records/namespaces/kb_articles/search').length, 2)
    assert.equal(pinecone.peticiones.filter(item => item.ruta === '/records/namespaces/knowledge_desk_documents/search').length, 2)
    assert.equal(pinecone.peticiones.length, 4)
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
    assert.equal(pinecone.peticiones.length, 2, 'una búsqueda en el corpus base y otra en los documentos')
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

  it('las cargas escriben solo en el namespace de documentos, nunca en el corpus base', async () => {
    const carga = await app.inject({ method: 'POST', url: '/api/documentos', ...multipart('a.json', json(articuloSimple('prueba_directo', 'Prueba', 'Texto suficiente para un fragmento de prueba del modo directo.'))) })
    assert.equal(carga.statusCode, 202)
    await servicios.gestor.esperarInactividad()
    const documentos = (await app.inject({ method: 'GET', url: '/api/documentos' })).json()
    assert.equal(documentos.indexacionConfigurada, true)
    assert.equal(documentos.documentos[0].estado, 'indexado')
    const mutaciones = pinecone.peticiones.filter(item => MUTACIONES.test(item.ruta))
    assert.ok(mutaciones.length > 0)
    assert.ok(mutaciones.every(item => item.namespace === 'knowledge_desk_documents'), 'ninguna mutación fuera del namespace de documentos')
    assert.ok(pinecone.peticiones.every(item => item.namespace !== 'kb_articles' || item.ruta.endsWith('/search')), 'el corpus base solo se busca')
    const eliminacion = await app.inject({ method: 'POST', url: `/api/documentos/${documentos.documentos[0].id}/eliminacion`, payload: { confirmado: true } })
    assert.equal(eliminacion.json().operacion.resultado, 'exitoso')
    assert.ok(pinecone.peticiones.filter(item => MUTACIONES.test(item.ruta)).every(item => item.namespace === 'knowledge_desk_documents'))
    assert.equal([...pinecone.registros.values()].filter(registro => registro.__ns === 'kb_articles').length, 3, 'el corpus base sigue intacto')
  })

  it('el estado no expone claves ni el host de Pinecone', async () => {
    const respuesta = await app.inject({ method: 'GET', url: '/api/estado' })
    const texto = respuesta.body
    assert.equal(respuesta.json().modo, 'directo')
    assert.equal(respuesta.json().consulta.motor, 'directo')
    assert.deepEqual(respuesta.json().indexacion, { configurada: true, destino: 'Pinecone · namespace knowledge_desk_documents' })
    assert.deepEqual(respuesta.json().busqueda, { destino: 'Pinecone · namespace kb_articles', soloLectura: true })
    assert.deepEqual(respuesta.json().limites.formatos, ['json', 'pdf', 'docx', 'txt'])
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
    // Con Pinecone configurado indexa, pero solo en el namespace de documentos.
    const completa = loadConfig({ ...base, PINECONE_API_KEY: 'k', PINECONE_INDEX_HOST: 'https://indice.example', KD_LLM_BASE_URL: 'https://llm.example/v1', KD_CHAT_MODEL: 'm', KD_EMBEDDINGS_MODEL: 'ignorado' })
    assert.deepEqual(capacidades(completa), { consulta: true, indexacion: true, faltan: [] })
    assert.equal(completa.pinecone?.documentosNamespace, 'knowledge_desk_documents')
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

  it('el namespace de documentos nunca puede ser el namespace base', () => {
    const conPinecone = { ...base, PINECONE_API_KEY: 'k', PINECONE_INDEX_HOST: 'https://indice.example' }
    assert.throws(() => loadConfig({ ...conPinecone, KD_DOCUMENTOS_NAMESPACE: 'kb_articles' }), /distinto de PINECONE_NAMESPACE/)
    assert.throws(() => loadConfig({ ...conPinecone, PINECONE_NAMESPACE: 'otro', KD_DOCUMENTOS_NAMESPACE: 'otro' }), /distinto de PINECONE_NAMESPACE/)
    assert.throws(() => loadConfig({ ...conPinecone, KD_DOCUMENTOS_NAMESPACE: 'con espacios' }), /solo admite/)
    assert.equal(loadConfig({ ...conPinecone, KD_DOCUMENTOS_NAMESPACE: 'kd_docs_qa' }).pinecone?.documentosNamespace, 'kd_docs_qa')
    // Inversión: base en otro namespace y documentos apuntando al corpus compartido.
    assert.throws(() => loadConfig({ ...conPinecone, PINECONE_NAMESPACE: 'otro_base', KD_DOCUMENTOS_NAMESPACE: 'kb_articles' }), /no puede ser kb_articles/)
  })

  it('el adaptador de escritura protege kb_articles aunque el base sea otro', () => {
    const fetchApi = async () => Response.json({})
    assert.throws(() => crearIndicePinecone({ apiKey: 'k', indexHost: 'http://pinecone.simulado', namespace: 'kb_articles' }, {
      fetchApi, escrituraAcotada: { prefijo: 'kd_', namespacesProtegidos: ['otro_base', 'kb_articles'] },
    }), /namespace protegido/)
  })

  it('el modo local conserva temperature 0', () => {
    const local = loadConfig({ KD_MODO: 'local', KD_LLM_BASE_URL: 'http://127.0.0.1:1/v1', KD_CHAT_MODEL: 'm', KD_EMBEDDINGS_MODEL: 'e' })
    assert.equal(local.proveedor?.temperatura, 0)
    assert.throws(() => loadConfig({ KD_MODO: 'otro' }), /forusguide, local o directo/)
  })
})

// Consulta "¿Cómo hago un retiro de mi 401(k)?" (2026-11-04): con evidencia fuerte,
// el modelo declaraba como vacíos detalles, temas vecinos o datos de quien pregunta,
// y la política (2+ vacíos → baja) bloqueaba la respuesta. La corrección está en
// PROMPT_SISTEMA y solo una evaluación con el modelo real la valida; está registrada en
// docs/verificacion/COBERTURA_DIRECTO_2026-11-04.md. Estas pruebas fijan el CONTRATO
// con salidas ya observadas: fragmentos sintéticos de afinidad 0,60, y "respuesta" y
// "vacios_de_cobertura" copiados exactamente de las salidas v5 de gpt-5.5 de los casos
// s1, s2 y s3 del JSON de evidencia, que no registró los puntos clave. No demuestran
// cómo se comporta el modelo.
describe('Modo directo · contrato con vacíos declarados por el modelo', () => {
  const PORTAL: [string, string][] = [
    ['steps', 'La solicitud de retiro se inicia desde el portal.'],
    ['steps', 'En el portal, abre Retiros y selecciona Iniciar solicitud.'],
  ]
  const umbrales = loadConfig({}).cobertura
  let dir: string
  let registro: Registro
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kd-directo-vacios-'))
    registro = new Registro(dir)
    await registro.cargar()
  })
  after(async () => { await rm(dir, { recursive: true, force: true }) })

  async function preguntar(pregunta: string, fragmentos: [string, string][], redaccion: unknown) {
    const llm = crearLlmSimulado()
    llm.subconsultas = []
    llm.redaccion = () => redaccion
    const proveedor = crearProveedor({ baseUrl: 'http://llm.simulado/v1', apiKey: CLAVE_LLM, embeddingModel: '', chatModel: 'gpt-simulado', chatReasoningEffort: null, temperatura: null }, llm.fetch)
    const buscador: BuscadorCorpus = {
      descripcion: 'simulado',
      fragmentosArticulo: async () => [],
      buscar: async () => fragmentos.map(([tipo, contenido], indice) => ({
        id: `sintetico_chunk_${indice + 1}`, score: 0.6, metadata: { article_id: 'sintetico', article_title: 'Artículo sintético', chunk_type: tipo, content: contenido },
      })),
    }
    const motor = crearMotorDirecto({ proveedor, buscador, documentos: null, umbrales })
    return { contrato: await consultar({ motor, registro, umbrales, timeoutMs: 30_000 }, { question: pregunta }, 'req-00000000'), llm }
  }

  it('una respuesta general sustentada y sin vacíos se presenta con cobertura alta y su fuente', async () => {
    const { contrato, llm } = await preguntar('¿Cómo inicio un retiro de mi 401(k)?', PORTAL, {
      respuesta: 'La solicitud de retiro se inicia desde el portal. [1]\nEn el portal, abre Retiros y selecciona Iniciar solicitud. [2]', puntos_clave: [], vacios_de_cobertura: [], contradicciones: [],
    })
    assert.equal(redacciones(llm.llamadas)[0].cuerpo.messages[0].content, PROMPT_SISTEMA)
    assert.equal(contrato.outcome, 'answered')
    assert.equal(contrato.coverage.level, 'alta')
    assert.equal(contrato.coverage.sufficient, true)
    assert.ok(contrato.answer?.trim())
    assert.equal(contrato.coverage.relevant_fragments, 2)
    assert.equal(contrato.sources.length, 1)
    assert.equal(contrato.sources[0].fragment_count, 2)
    assert.deepEqual(contrato.found_documents, [])
  })

  it('formulario y plazo pedidos pero ausentes bloquean la respuesta aunque la evidencia sea fuerte, y la explicación lo dice', async () => {
    const { contrato } = await preguntar('¿Qué formulario debo usar para retirar mi 401(k) y cuál es el plazo exacto?', PORTAL, {
      respuesta: '',
      puntos_clave: [],
      vacios_de_cobertura: ['Qué formulario específico debe usarse para retirar el 401(k).', 'Cuál es el plazo exacto para retirar el 401(k).'],
      contradicciones: [],
    })
    assert.equal(contrato.outcome, 'insufficient')
    assert.equal(contrato.answer, null)
    assert.deepEqual(contrato.sources, [])
    assert.equal(contrato.found_documents.length, 1)
    assert.equal(contrato.coverage.level, 'baja')
    assert.equal(contrato.coverage.relevant_fragments, 2)
    // Sin nivel del motor también se explica el motivo real: no "apenas toca tu consulta".
    assert.match(contrato.coverage.explanation, /declaró que la documentación recuperada no cubre partes de la pregunta/)
  })

  it('una respuesta condicional citada y sin vacíos se presenta con sus dos fuentes', async () => {
    const { contrato } = await preguntar('¿Puedo hacer un retiro en servicio de mi 401(k)?', [
      ['eligibility', 'En este ejemplo sintético, el retiro en servicio requiere al menos 60 años.'],
      ['business_rules', 'El plan debe habilitar esa modalidad.'],
    ], {
      respuesta: 'Para poder hacer un retiro en servicio de tu 401(k), en este ejemplo necesitas tener al menos 60 años y que el plan habilite esa modalidad [1][2]. No puedo confirmar si tú puedes hacerlo sin saber tu edad y si tu plan habilita el retiro en servicio [1][2].',
      puntos_clave: [], vacios_de_cobertura: [], contradicciones: [],
    })
    assert.equal(contrato.outcome, 'answered')
    assert.equal(contrato.coverage.level, 'alta')
    assert.equal(contrato.coverage.relevant_fragments, 2, 'las citas contiguas [1][2] cuentan las dos secciones')
    assert.equal(contrato.sources[0].fragment_count, 2)
    assert.doesNotMatch(contrato.answer ?? '', /\[\d\]/)
  })
})
