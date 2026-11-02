import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { construirApp, construirServicios } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { evaluarCobertura, normalizarVacios } from '../src/consulta/coverage.ts'
import type { Evidencia } from '../src/consulta/motor.ts'

// Caso reportado el 2026-11-01: pregunta sobre vacaciones contra el corpus de
// ForUsGuide, que trata planes 401(k). ForUsGuide se sustituye con un fetch
// inyectado que reproduce su contrato; nunca se llama al servicio real.
const CLAVE = 'clave-sintetica-forusguide-0123456789'

// La frase de la captura mide exactamente 100 caracteres. La pregunta enviada en
// Render la repetía 9 veces unidas por " La pregunta es: " (1036 caracteres).
const FRASE = '¿Cuál es el proceso para solicitar mis vacaciones y a quién debo enviar la solicitud para aprobarla?'
const PREGUNTA_REPORTADA = Array.from({ length: 9 }, () => FRASE).join(' La pregunta es: ')

// VALORES OBSERVADOS en una llamada pública directa a ForUsGuide
// (POST /api/v1/knowledge-question) con PREGUNTA_REPORTADA, el 2026-11-01:
// confidence_note limited_coverage, un único coverage_gap, 23 used_chunks de 11
// artículos y estas afinidades. Se conservan los identificadores, tipos y
// afinidades; el texto de los fragmentos del corpus se sustituye por un marcador.
// El servicio varía entre llamadas: en la consulta hecha desde Render con la
// misma pregunta, el nivel fue partially_covered (Cobertura parcial, base motor).
const OBSERVADOS: [string, number, string][] = [
  ['how_do_i_cancel_or_change_a_pending_distribution_request_chunk_38', 0.3325, 'additional_notes'],
  ['how_do_i_cancel_or_change_a_pending_distribution_request_chunk_21', 0.3213, 'example'],
  ['how_do_i_cancel_or_change_a_pending_distribution_request_chunk_34', 0.3206, 'faqs'],
  ['401k_loan_basics_and_support_guide_chunk_21', 0.3079, 'steps'],
  ['can_i_take_money_from_my_401k_while_employed_your_options_explained_chunk_50', 0.3053, 'additional_notes'],
  ['how_do_i_cancel_or_change_a_pending_distribution_request_chunk_32', 0.3032, 'faqs'],
  ['forusall_401k_hardship_withdrawal_complete_guide_chunk_26', 0.3032, 'faqs'],
  ['can_i_take_money_from_my_401k_while_employed_your_options_explained_chunk_23', 0.3014, 'steps'],
  ['401k_loan_basics_and_support_guide_chunk_72', 0.3001, 'faqs'],
  ['can_i_take_money_from_my_401k_while_employed_your_options_explained_chunk_48', 0.2976, 'faqs'],
  ['eaca_refunds_after_401k_auto_enrollment_chunk_17', 0.2929, 'steps'],
  ['lt_trust_401k_loan_complete_guide_submission_repayment_support_chunk_20', 0.2901, 'steps'],
  ['lt_request_401k_termination_withdrawal_or_rollover_chunk_26', 0.2742, 'steps'],
  ['vanguard_how_to_submit_a_loan_request_chunk_33', 0.273, 'faqs'],
  ['401k_force_out_process_sponsor_faq_chunk_16', 0.2693, 'steps'],
  ['401k_loan_basics_and_support_guide_chunk_19', 0.2674, 'steps'],
  ['401k_force_out_process_involuntary_distribution_balance_thresholds_safe_harbor_ira_rollovers_fee_outs_compliance_chunk_17', 0.2647, 'steps'],
  ['can_i_take_money_from_my_401k_while_employed_your_options_explained_chunk_17', 0.2638, 'business_rules'],
  ['lt_trust_401k_loan_complete_guide_submission_repayment_support_chunk_18', 0.2588, 'steps'],
  ['how_do_i_cancel_or_change_a_pending_distribution_request_chunk_33', 0.2513, 'faqs'],
  ['can_i_split_my_401_k_rollover_between_multiple_providers_chunk_20', 0.2507, 'steps'],
  ['vanguard_how_to_submit_a_loan_request_chunk_13', 0.2493, 'business_rules'],
  ['lt_request_401k_termination_withdrawal_or_rollover_chunk_22', 0.2491, 'business_rules'],
]
const VACIO_OBSERVADO = 'Proceso para solicitar vacaciones o PTO y la persona/equipo que debe aprobar o recibir esa solicitud'
const RESPUESTA_OBSERVADA = 'No puedo indicar el proceso para solicitar vacaciones ni a quién enviar esa solicitud porque ese tema no aparece en el contexto proporcionado.'

const usadosObservados = () => OBSERVADOS.map(([chunkId, score, tipo]) => {
  const articulo = chunkId.slice(0, chunkId.lastIndexOf('_chunk_'))
  return { chunk_id: chunkId, score, chunk_type: tipo, article_id: articulo, article_title: articulo, content: `Contenido del fragmento ${chunkId} (sustituido).` }
})

function respuestaMotor(cambios: { confidence_note?: string; coverage_gaps?: unknown[]; answer?: string; used_chunks?: ReturnType<typeof usadosObservados> } = {}) {
  const usados = cambios.used_chunks ?? usadosObservados()
  const articulos = [...new Set(usados.map(item => item.article_id))]
  return {
    answer: cambios.answer ?? RESPUESTA_OBSERVADA,
    key_points: ['El contexto no contiene información sobre solicitudes de vacaciones o PTO.'],
    source_articles: articulos.map(articulo => ({ article_id: articulo, article_title: articulo })),
    used_chunks: usados,
    confidence_note: cambios.confidence_note ?? 'limited_coverage',
    metadata: {
      chunks_used: usados.length, unique_articles: articulos.length, model: 'modelo-sintetico',
      sub_queries: ['proceso para solicitar vacaciones y persona o gerente que debe aprobar la solicitud'],
      coverage_gaps: cambios.coverage_gaps ?? [VACIO_OBSERVADO],
    },
  }
}

// Evidencia fuerte y sintética, para los casos en que la respuesta sí debe presentarse.
const FUERTES = [0.47, 0.43, 0.39].map((score, indice) => ({
  chunk_id: `retiros_401k_chunk_${indice + 1}`, score, chunk_type: 'steps', article_id: 'retiros_401k', article_title: 'Retiros de un 401(k) (sintético)', content: `Paso ${indice + 1} sintético de un retiro.`,
}))

const json = (status: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })

describe('Consulta: límite de 100 caracteres y respuestas del motor sin sustento', () => {
  let dir: string
  let app: FastifyInstance
  const llamadas: { url: string; cuerpo: unknown }[] = []
  let siguiente: () => Response = () => json(200, respuestaMotor())

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kd-consulta-validacion-'))
    const config = loadConfig({
      KD_MODO: 'forusguide', FORUSGUIDE_API_URL: 'https://forusguide.invalid', FORUSGUIDE_API_KEY: CLAVE,
      KD_DATA_DIR: path.join(dir, 'datos'), KD_UI_DIST: path.join(dir, 'sin-ui'),
    })
    const fetchForUsGuide = (async (url: string | URL | Request, init?: RequestInit) => {
      llamadas.push({ url: String(url), cuerpo: JSON.parse(String(init?.body ?? 'null')) })
      return siguiente()
    }) as typeof fetch
    app = await construirApp(await construirServicios(config, { fetchForUsGuide }), { logger: false })
  })
  after(async () => {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  })
  beforeEach(() => {
    llamadas.length = 0
    siguiente = () => json(200, respuestaMotor())
  })

  const consultar = (question: unknown) => app.inject({ method: 'POST', url: '/api/consulta', payload: { question } })

  it('rechaza fuera de 10..100 puntos de código antes de llamar a ForUsGuide, en ASCII y en Unicode', async () => {
    const emoji = '\u{1F600}' // un punto de código, dos unidades UTF-16
    assert.equal(Array.from(PREGUNTA_REPORTADA).length, 1036)
    const invalidas: [string, string][] = [
      ['a'.repeat(9), 'corta'],
      [`   ${'a'.repeat(9)}   `, 'corta'],
      [emoji.repeat(9), 'corta'],
      ['a'.repeat(101), 'larga'],
      ['ñ'.repeat(101), 'larga'],
      [emoji.repeat(101), 'larga'],
      [`${FRASE}?`, 'larga'],
      [PREGUNTA_REPORTADA, 'larga'],
      [' \t\n ', 'vacia'],
    ]
    for (const [pregunta, motivo] of invalidas) {
      const respuesta = await consultar(pregunta)
      assert.equal(respuesta.statusCode, 422, `${motivo}: ${Array.from(pregunta).length} puntos de código`)
      assert.equal(respuesta.json().code, 'VALIDATION_ERROR')
      assert.equal(respuesta.json().details.motivo, motivo)
      if (motivo === 'larga') assert.match(respuesta.json().message, /no puede superar 100 caracteres/)
    }
    // Un cuerpo de más de 64 KB tampoco llega a ForUsGuide.
    const enorme = await consultar('a'.repeat(70_000))
    assert.equal(enorme.statusCode, 422)
    assert.equal(enorme.json().code, 'VALIDATION_ERROR')
    assert.equal(llamadas.length, 0, 'ninguna pregunta inválida llega a ForUsGuide')
  })

  it('acepta 10, 99 y 100 caracteres (ASCII y Unicode) y envía la pregunta completa', async () => {
    const emoji = '\u{1F600}'
    const validas = ['a'.repeat(10), 'a'.repeat(99), 'a'.repeat(100), 'é'.repeat(100), emoji.repeat(10), emoji.repeat(100), `  ${'b'.repeat(100)}  `, FRASE]
    siguiente = () => json(200, respuestaMotor({ confidence_note: 'well_covered', coverage_gaps: [], used_chunks: FUERTES, answer: 'Respuesta sintética sustentada.' }))
    for (const pregunta of validas) {
      const respuesta = await consultar(pregunta)
      assert.equal(respuesta.statusCode, 200, `${Array.from(pregunta.trim()).length} puntos de código`)
      assert.equal(respuesta.json().question, pregunta.trim())
    }
    assert.equal(Array.from(FRASE).length, 100)
    assert.deepEqual(llamadas.map(llamada => (llamada.cuerpo as { question: string }).question), validas.map(pregunta => pregunta.trim()))
  })

  it('evidencia observada en la llamada directa (limited_coverage, un vacío): no se presenta la respuesta', async () => {
    const contrato = (await consultar(FRASE)).json()
    assert.equal(contrato.outcome, 'insufficient')
    assert.equal(contrato.answer, null)
    assert.deepEqual(contrato.key_points, [])
    assert.deepEqual(contrato.sources, [])
    assert.equal(contrato.coverage.level, 'baja')
    assert.equal(contrato.coverage.basis, 'motor')
    assert.equal(contrato.coverage.relevant_fragments, 23)
    assert.equal(contrato.coverage.documents, 11)
    assert.equal(contrato.found_documents.length, 11)
  })

  it('variante de regresión: la misma evidencia con partially_covered (nivel observado en Render) tampoco se presenta', async () => {
    siguiente = () => json(200, respuestaMotor({ confidence_note: 'partially_covered' }))
    const contrato = (await consultar(FRASE)).json()
    // Un vacío declarado y una media de las 5 mejores afinidades de 0,31752,
    // por debajo de KD_COBERTURA_ALTA (0,35): la política da baja y el nivel del
    // motor (parcial) baja a ese tope.
    assert.equal(contrato.outcome, 'insufficient')
    assert.equal(contrato.answer, null)
    assert.deepEqual(contrato.sources, [])
    assert.equal(contrato.coverage.level, 'baja')
    assert.equal(contrato.coverage.basis, 'politica')
    assert.match(contrato.coverage.explanation, /declaró que la documentación recuperada no cubre partes de la pregunta/)
    assert.doesNotMatch(JSON.stringify(contrato.found_documents), /No puedo indicar/)
  })

  it('variante sintética con dos vacíos distintos y nivel del motor alto: tampoco se presenta', async () => {
    for (const nota of ['partially_covered', 'well_covered']) {
      siguiente = () => json(200, respuestaMotor({ confidence_note: nota, coverage_gaps: ['Proceso para solicitar vacaciones', 'Persona que aprueba la solicitud'], used_chunks: FUERTES }))
      const contrato = (await consultar(FRASE)).json()
      assert.equal(contrato.outcome, 'insufficient', nota)
      assert.equal(contrato.coverage.level, 'baja')
    }
  })

  it('vacíos repetidos o en blanco no rebajan la cobertura: cuentan como uno solo', async () => {
    siguiente = () => json(200, respuestaMotor({
      confidence_note: 'well_covered', used_chunks: FUERTES, answer: 'Respuesta sintética sustentada.',
      coverage_gaps: ['Plazo de entrega', '  plazo   de entrega ', '', '   ', 'PLAZO DE ENTREGA', null],
    }))
    const contrato = (await consultar(FRASE)).json()
    // Un único vacío con evidencia fuerte (media 0,43): como máximo parcial, y se presenta.
    assert.equal(contrato.outcome, 'answered')
    assert.equal(contrato.coverage.level, 'parcial')
    assert.equal(contrato.coverage.sufficient, true)
  })

  it('distingue la insuficiencia documental (200, texto con "401(k)") de un rechazo HTTP 401 o 403 de ForUsGuide', async () => {
    const insuficiente = await consultar(FRASE)
    assert.equal(insuficiente.statusCode, 200)
    assert.equal(insuficiente.json().status, 'ok')
    assert.equal(insuficiente.json().outcome, 'insufficient')
    for (const status of [401, 403]) {
      siguiente = () => json(status, { error: 'unauthorized', message: 'Invalid API key', request_id: 'sintetico' })
      const respuesta = await consultar(FRASE)
      assert.equal(respuesta.statusCode, 502)
      const cuerpo = respuesta.json()
      assert.equal(cuerpo.status, 'error')
      assert.equal(cuerpo.code, 'UPSTREAM_AUTH_ERROR')
      assert.equal(cuerpo.details.upstream_status, status)
      assert.doesNotMatch(respuesta.body, /Invalid API key|insufficient/)
    }
  })
})

describe('kd-cobertura-v1: el nivel del motor es un techo que la evidencia y los vacíos solo pueden bajar', () => {
  const UMBRALES = { minScore: 0.2, altaScore: 0.35, mediaScore: 0.22 }
  const evidencia = (score: number, indice: number): Evidencia => ({ chunkId: `art_chunk_${indice}`, articleId: 'art', articleTitle: 'Artículo', score, chunkType: 'faqs', content: `Fragmento ${indice}`, paths: [] })
  const fuertes = [evidencia(0.6, 1), evidencia(0.5, 2)]
  const observadas = OBSERVADOS.map(([, score], indice) => evidencia(score, indice))

  it('dos o más vacíos dan baja; uno da parcial solo con evidencia fuerte; ninguno respeta al motor', () => {
    const dos = evaluarCobertura(fuertes, 'well_covered', ['tema a', 'tema b'], UMBRALES)
    assert.equal(dos.level, 'baja')
    assert.equal(dos.basis, 'politica')
    const unoFuerte = evaluarCobertura(fuertes, 'well_covered', ['tema a'], UMBRALES)
    assert.equal(unoFuerte.level, 'parcial')
    assert.equal(unoFuerte.basis, 'politica')
    const unoParcial = evaluarCobertura(fuertes, 'partially_covered', ['tema a'], UMBRALES)
    assert.equal(unoParcial.level, 'parcial')
    assert.equal(unoParcial.basis, 'motor')
    // Valores observados: un vacío y media 0,31752 (< 0,35) bajan partially_covered a baja.
    const unoDebil = evaluarCobertura(observadas, 'partially_covered', [VACIO_OBSERVADO], UMBRALES)
    assert.equal(unoDebil.level, 'baja')
    assert.equal(unoDebil.sufficient, false)
    assert.equal(evaluarCobertura(fuertes, 'well_covered', [], UMBRALES).level, 'alta')
  })

  it('la evidencia sola también es techo, y nada sube el nivel del motor', () => {
    // Sin vacíos y con media < 0,35, well_covered queda en parcial.
    const media = evaluarCobertura([evidencia(0.3, 1), evidencia(0.3, 2)], 'well_covered', [], UMBRALES)
    assert.equal(media.level, 'parcial')
    assert.equal(media.basis, 'politica')
    assert.equal(evaluarCobertura(fuertes, 'limited_coverage', [], UMBRALES).level, 'baja')
    assert.equal(evaluarCobertura(fuertes, 'limited_coverage', [], UMBRALES).basis, 'motor')
    assert.equal(evaluarCobertura(fuertes, 'partially_covered', [], UMBRALES).level, 'parcial')
  })

  it('normaliza los vacíos: sin blancos, sin espacios sobrantes y sin repetidos', () => {
    assert.deepEqual(normalizarVacios(['  Plazo  de entrega ', 'plazo de entrega', '', '   ', 'Monto', null, 42, 'MONTO']), ['Plazo de entrega', 'Monto'])
    const repetido = evaluarCobertura(fuertes, 'well_covered', ['Plazo', ' plazo ', 'PLAZO'], UMBRALES)
    assert.equal(repetido.level, 'parcial', 'un vacío repetido no se convierte en dos')
    assert.equal(evaluarCobertura(fuertes, 'well_covered', ['', '  '], UMBRALES).level, 'alta')
  })
})
