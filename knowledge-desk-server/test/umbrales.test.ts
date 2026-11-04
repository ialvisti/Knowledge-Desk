import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { loadConfig } from '../src/config.ts'
import { evaluarCobertura, type NivelCobertura, type Umbrales } from '../src/consulta/coverage.ts'
import type { Evidencia, Motor } from '../src/consulta/motor.ts'
import { consultar } from '../src/consulta/service.ts'
import { Registro } from '../src/documents/store.ts'

// CP-HU05-03 · Fronteras de la política kd-cobertura-v1 con los umbrales
// APROBADOS en la configuración (KD_COBERTURA_MIN/ALTA/MEDIA por defecto: 0,2,
// 0,35 y 0,22; no se cambian para la prueba). Cada umbral T se prueba con
// T − u, T y T + u para dos unidades mínimas:
//  - u = 1e-6: muy por debajo de cualquier diferencia significativa entre
//    afinidades (Pinecone las da con ~4 decimales y los umbrales tienen 2) y muy
//    por encima del ULP de un double en [0,2; 0,35] (~5,6e-17), así T ± u son
//    valores distintos y representables.
//  - u = 1 ULP: el double inmediatamente anterior y posterior a T, la unidad
//    mínima absoluta de la representación. Prueba que la comparación es exacta.
// Regla aprobada: todas las comparaciones son "mayor o igual" (T incluido).
// Con dos fragmentos de la misma afinidad x la media es exactamente x
// ((x + x) / 2 es exacto en coma flotante), así la media cae justo en la frontera.

function vecino(valor: number, sentido: 1 | -1): number {
  const vista = new DataView(new ArrayBuffer(8))
  vista.setFloat64(0, valor)
  vista.setBigUint64(0, vista.getBigUint64(0) + BigInt(sentido))
  return vista.getFloat64(0)
}

const UNIDADES: [string, (t: number, sentido: 1 | -1) => number][] = [
  ['1e-6', (t, sentido) => t + sentido * 1e-6],
  ['1 ULP', (t, sentido) => vecino(t, sentido)],
]

const evidencia = (...scores: number[]): Evidencia[] => scores.map((score, indice) => ({
  chunkId: `c${indice}`, articleId: `a${indice}`, articleTitle: 'A', score, chunkType: 'business_rules', content: `contenido ${indice}`, paths: [],
}))

describe('CP-HU05-03 · fronteras de los umbrales de cobertura', () => {
  const config = loadConfig({})
  const umbrales: Umbrales = config.cobertura

  it('usa los umbrales aprobados de la configuración', () => {
    assert.deepEqual(umbrales, { minScore: 0.2, altaScore: 0.35, mediaScore: 0.22 })
  })

  for (const [unidad, mover] of UNIDADES) {
    it(`minScore (relevancia, ≥ ${umbrales.minScore}) con u = ${unidad}`, () => {
      const T = umbrales.minScore
      const casos: [number, NivelCobertura, number][] = [
        [mover(T, -1), 'sin_evidencia', 0], // excluido: no es relevante
        [T, 'baja', 1], // incluido: relevante; media T < mediaScore
        [mover(T, 1), 'baja', 1],
      ]
      for (const [score, nivel, relevantes] of casos) {
        const cobertura = evaluarCobertura(evidencia(score), null, [], umbrales)
        assert.equal(cobertura.level, nivel, `score ${score}`)
        assert.equal(cobertura.relevant_fragments, relevantes, `score ${score}`)
        assert.equal(cobertura.sufficient, false)
      }
    })

    it(`mediaScore (parcial, media ≥ ${umbrales.mediaScore}) con u = ${unidad}`, () => {
      const T = umbrales.mediaScore
      for (const [score, nivel] of [[mover(T, -1), 'baja'], [T, 'parcial'], [mover(T, 1), 'parcial']] as const) {
        const cobertura = evaluarCobertura(evidencia(score), null, [], umbrales)
        assert.equal(cobertura.level, nivel, `score ${score}`)
        assert.equal(cobertura.sufficient, nivel === 'parcial')
      }
    })

    it(`altaScore (alta, media ≥ ${umbrales.altaScore} con 2+ relevantes) con u = ${unidad}`, () => {
      const T = umbrales.altaScore
      for (const [score, nivel] of [[mover(T, -1), 'parcial'], [T, 'alta'], [mover(T, 1), 'alta']] as const) {
        assert.equal(evaluarCobertura(evidencia(score, score), null, [], umbrales).level, nivel, `score ${score}`)
      }
      // Con un solo fragmento relevante nunca es alta, aunque supere el umbral.
      assert.equal(evaluarCobertura(evidencia(mover(T, 1)), null, [], umbrales).level, 'parcial')
    })

    it(`altaScore con un vacío declarado (parcial solo si media ≥ ${umbrales.altaScore}) con u = ${unidad}`, () => {
      const T = umbrales.altaScore
      for (const [score, nivel] of [[mover(T, -1), 'baja'], [T, 'parcial'], [mover(T, 1), 'parcial']] as const) {
        assert.equal(evaluarCobertura(evidencia(score, score), null, ['tema no cubierto'], umbrales).level, nivel, `score ${score}`)
      }
    })
  }

  it('los valores de frontera son distintos de T en ambas unidades', () => {
    for (const T of [umbrales.minScore, umbrales.mediaScore, umbrales.altaScore]) {
      for (const [, mover] of UNIDADES) {
        assert.ok(mover(T, -1) < T && T < mover(T, 1))
      }
    }
  })
})

// La misma frontera de inclusión en el servicio: un fragmento en T − u no se
// lista como fuente; uno en T sí.
describe('CP-HU05-03 · la frontera de relevancia en las fuentes del servicio', () => {
  let dir: string
  let registro: Registro
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kd-umbrales-'))
    registro = new Registro(dir)
    await registro.cargar()
  })
  after(async () => { await rm(dir, { recursive: true, force: true }) })

  it('incluye T y excluye T − 1 ULP y T − 1e-6', async () => {
    const T = 0.2
    const motor: Motor = {
      nombre: 'directo',
      async preguntar() {
        return {
          motor: 'directo', respuesta: 'Respuesta sustentada.', puntosClave: [], nivelMotor: null, vaciosCobertura: [], contradicciones: [],
          modelo: 'm', subconsultas: [], fragmentosRecuperados: 5, articulosConsultados: 5, generada: true,
          evidencia: [
            { chunkId: 'alto', articleId: 'alto', articleTitle: 'Alto', score: 0.6, chunkType: 'steps', content: 'a', paths: [] },
            { chunkId: 'alto2', articleId: 'alto2', articleTitle: 'Alto 2', score: 0.6, chunkType: 'steps', content: 'b', paths: [] },
            { chunkId: 'en_t', articleId: 'en_t', articleTitle: 'En T', score: T, chunkType: 'steps', content: 'c', paths: [] },
            { chunkId: 'ulp', articleId: 'ulp', articleTitle: 'ULP', score: vecino(T, -1), chunkType: 'steps', content: 'd', paths: [] },
            { chunkId: 'micro', articleId: 'micro', articleTitle: 'Micro', score: T - 1e-6, chunkType: 'steps', content: 'e', paths: [] },
          ],
        }
      },
    }
    const respuesta = await consultar({ motor, registro, umbrales: loadConfig({}).cobertura, timeoutMs: 30_000 }, { question: 'Una pregunta válida' }, 'req-00000000')
    assert.equal(respuesta.outcome, 'answered')
    assert.deepEqual(respuesta.sources.map(fuente => fuente.id).sort(), ['alto', 'alto2', 'en_t'])
    assert.equal(respuesta.coverage.relevant_fragments, 3)
    assert.equal(respuesta.coverage.total_fragments, 5)
  })
})
