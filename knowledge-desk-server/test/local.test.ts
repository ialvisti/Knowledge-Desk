import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { construirApp, construirServicios, type Servicios } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { unidadesAfirmativas } from '../src/consulta/local.ts'
import type { FastifyInstance } from 'fastify'
import { articulo, articuloSimple, json } from './support/articulos.ts'
import { multipart } from './support/entorno.ts'
import { crearProveedorSimulado, type ProveedorSimulado } from './support/proveedor-simulado.ts'
import { VIATICOS_V1 } from './support/demo-documentos.ts'

// Modo local con un proveedor OpenAI-compatible simulado. Comprueba el
// comportamiento de Knowledge Desk (recuperación por vectores, descomposición,
// deduplicación, trazabilidad), no la calidad de un modelo real.
describe('Modo local · HU02 y HU03 con embeddings y redacción simulados', () => {
  let dir: string
  let app: FastifyInstance
  let servicios: Servicios
  let proveedor: ProveedorSimulado

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kd-local-'))
    await writeFile(path.join(dir, 'ejemplos.json'), JSON.stringify({ local: ['¿Cómo se solicita el reembolso de viáticos internacionales?', '¿Cuántas semanas de licencia parental corresponden?', '¿Cuál es mi saldo en la cuenta bancaria de nómina?'] }))
    proveedor = crearProveedorSimulado()
    const config = loadConfig({
      KD_MODO: 'local', KD_LLM_BASE_URL: 'http://proveedor.simulado/v1', KD_EMBEDDINGS_MODEL: 'emb-simulado', KD_CHAT_MODEL: 'chat-simulado',
      KD_DATA_DIR: path.join(dir, 'datos'), KD_UI_DIST: path.join(dir, 'sin-ui'), KD_EJEMPLOS_ARCHIVO: path.join(dir, 'ejemplos.json'),
      KD_VERIFICACION_INDICE_MS: '500', KD_VERIFICACION_INTERVALO_MS: '20',
    })
    servicios = await construirServicios(config, { fetchProveedor: proveedor.fetch })
    app = await construirApp(servicios, { logger: false })
    for (const [nombre, contenido] of [
      ['Politica_Viaticos.json', json(VIATICOS_V1)],
      ['Comedor.json', json(articulo('comedor_central', 'Comedor central', { business_rules: [{ category: 'horario', rules: ['El comedor central atiende de lunes a viernes en horario de almuerzo para todo el personal.'] }] }))],
    ] as const) {
      const respuesta = await app.inject({ method: 'POST', url: '/api/documentos', ...multipart(nombre, contenido) })
      assert.equal(respuesta.statusCode, 202)
    }
    await servicios.gestor.esperarInactividad()
  })
  after(async () => {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  })

  const preguntar = async (question: string) => (await app.inject({ method: 'POST', url: '/api/consulta', payload: { question } })).json()

  it('indexa con embeddings del proveedor y recupera por similitud de vectores, no por coincidencia literal', async () => {
    assert.deepEqual(servicios.gestor.listar().map(doc => doc.estado), ['indexado', 'indexado'])
    proveedor.llamadas.length = 0
    // La pregunta usa otras palabras (devolución, exterior); la relación con
    // "reembolso" e "internacionales" sale de los vectores del proveedor.
    const contrato = await preguntar('¿Cómo pido la devolución de gastos de un viaje al exterior?')
    assert.equal(contrato.outcome, 'answered')
    assert.ok(contrato.sources.length > 0)
    assert.ok(contrato.sources.every((fuente: { title: string; file_name: string }) => fuente.title === 'Política de viáticos internacionales' && fuente.file_name === 'Politica_Viaticos.json'))
    assert.ok(proveedor.llamadas.some(llamada => llamada.ruta === '/embeddings'))
  })

  it('divide una pregunta de varios temas, unifica y deduplica antes de construir el contexto', async () => {
    proveedor.llamadas.length = 0
    const contrato = await preguntar('¿Cuál es el plazo para pedir el reembolso de viáticos internacionales y qué documentos debo adjuntar?')
    assert.equal(contrato.retrieval.sub_queries.length, 2)
    const embeddings = proveedor.llamadas.find(llamada => llamada.ruta === '/embeddings')!
    assert.equal((embeddings.cuerpo.input as string[]).length, 3)
    const chat = proveedor.llamadas.find(llamada => llamada.ruta === '/chat/completions')!
    const contexto = (chat.cuerpo.messages as { role: string; content: string }[])[1].content
    const secciones = contexto.match(/^\[\d+\] Fuente:/gm) ?? []
    const textos = contexto.split(/^\[\d+\] Fuente: .*$/m).slice(1).map(seccion => seccion.trim())
    assert.equal(new Set(textos).size, secciones.length, 'ningún fragmento entra dos veces al contexto')
  })

  it('sin evidencia relevante no llama al modelo y lo informa como sin evidencia', async () => {
    proveedor.llamadas.length = 0
    const contrato = await preguntar('¿Cuál es la capital administrativa de Mongolia?')
    assert.equal(contrato.outcome, 'insufficient')
    assert.equal(contrato.coverage.level, 'sin_evidencia')
    assert.equal(contrato.retrieval.generated, false)
    assert.ok(!proveedor.llamadas.some(llamada => llamada.ruta === '/chat/completions'))
  })

  it('una cita a una sección inexistente invalida la respuesta: no se oculta ni se presenta como sustentada', async () => {
    proveedor.chat = () => ({ respuesta: 'Se pagan cien millones [99]. El trámite requiere aprobación del jefe inmediato [1].', puntos_clave: [{ texto: 'Requiere aprobación', fuentes: [1] }], vacios_de_cobertura: [], contradicciones: [] })
    const contrato = await preguntar('¿Cómo se solicita el reembolso de viáticos internacionales?')
    assert.equal(contrato.outcome, 'insufficient')
    assert.equal(contrato.answer, null)
    assert.match(contrato.coverage.explanation, /secciones que no existen/)
  })

  it('una afirmación sin cita o un punto clave sin fuente válida también invalidan la respuesta', async () => {
    proveedor.chat = () => ({ respuesta: 'El reembolso se pide en el portal [1]. Además se paga en efectivo al día siguiente.', puntos_clave: [{ texto: 'Portal de gastos', fuentes: [1] }], vacios_de_cobertura: [], contradicciones: [] })
    let contrato = await preguntar('¿Cómo se solicita el reembolso de viáticos internacionales?')
    assert.equal(contrato.outcome, 'insufficient')
    assert.match(contrato.coverage.explanation, /sin cita/)

    proveedor.chat = () => ({ respuesta: 'El reembolso se pide en el portal [1].', puntos_clave: [{ texto: 'Dato sin respaldo', fuentes: [7] }], vacios_de_cobertura: [], contradicciones: [] })
    contrato = await preguntar('¿Cómo se solicita el reembolso de viáticos internacionales?')
    assert.equal(contrato.outcome, 'insufficient')
    assert.match(contrato.coverage.explanation, /punto clave cita/)
  })

  it('una respuesta citada por completo se presenta y sus fuentes son las secciones citadas', async () => {
    proveedor.chat = () => ({
      respuesta: 'El reembolso se solicita en el portal de gastos [1].\n\nLos pasos son:\n- Adjuntar las facturas originales [1].',
      puntos_clave: [{ texto: 'Plazo de 15 días', fuentes: [1] }],
      vacios_de_cobertura: [],
      contradicciones: [],
    })
    const contrato = await preguntar('¿Cómo se solicita el reembolso de viáticos internacionales?')
    assert.equal(contrato.outcome, 'answered')
    assert.doesNotMatch(contrato.answer, /\[\d+\]/)
    assert.deepEqual(contrato.key_points, ['Plazo de 15 días'])
    assert.equal(contrato.sources.length, 1)
    assert.equal(contrato.sources[0].fragment_count, 1)
  })

  it('los ejemplos solo muestran preguntas con evidencia en los documentos cargados y sin datos personales', async () => {
    const ejemplos = (await app.inject('/api/ejemplos')).json()
    assert.equal(ejemplos.verified, true)
    assert.deepEqual(ejemplos.examples, ['¿Cómo se solicita el reembolso de viáticos internacionales?'])
    assert.deepEqual(ejemplos.rejected.map((item: { reason: string }) => item.reason), ['promete datos personales o financieros'])
  })

  it('un fallo del proveedor se informa según la etapa: recuperación o redacción', async () => {
    proveedor.fallar = 'embeddings'
    let respuesta = await app.inject({ method: 'POST', url: '/api/consulta', payload: { question: '¿Cómo se solicita el reembolso de viáticos internacionales?' } })
    assert.equal(respuesta.json().code, 'RETRIEVAL_ERROR')
    proveedor.fallar = 'chat'
    respuesta = await app.inject({ method: 'POST', url: '/api/consulta', payload: { question: '¿Cómo se solicita el reembolso de viáticos internacionales?' } })
    assert.equal(respuesta.json().code, 'AI_PROVIDER_ERROR')
    assert.doesNotMatch(respuesta.body, /fallo simulado|proveedor\.simulado/)
    proveedor.fallar = null
  })

  it('un proveedor que devuelve embeddings corruptos no publica el documento', async () => {
    const original = proveedor.embeddings
    proveedor.embeddings = textos => ({ data: textos.map((_, index) => ({ index: 0, embedding: index ? [3, 4] : ['invalido'] })) })
    const corrupto = articuloSimple('archivo_central', 'Procedimiento de archivo', 'Los expedientes se rotulan con código de serie y fecha de apertura del archivo central.', 'La transferencia al archivo central se hace una vez al año con inventario firmado.', 'El inventario firmado se archiva con el acta.', 'El archivo central confirma la recepción.')
    const respuesta = await app.inject({ method: 'POST', url: '/api/documentos', ...multipart('Corrupto.json', json(corrupto)) })
    await servicios.gestor.esperarInactividad()
    proveedor.embeddings = original
    const doc = servicios.registro.documento(respuesta.json().documento.id)!
    assert.equal(doc.estado, 'error')
    assert.equal(doc.error!.etapa, 'embeddings')
    assert.deepEqual(await servicios.indice!.listarIds(`kd_${doc.id.toLowerCase().replace('-', '')}_`), [])
  })
})

describe('División en afirmaciones para exigir citas', () => {
  it('cada oración y viñeta es una afirmación; los títulos e introducciones no', () => {
    assert.deepEqual(unidadesAfirmativas('Los pasos son:\n- Adjuntar facturas [1].\nEl plazo es de 15 días. [2] Se paga en cinco días [2].'), [
      'Adjuntar facturas [1].', 'El plazo es de 15 días. [2]', 'Se paga en cinco días [2].',
    ])
  })
})
