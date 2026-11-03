import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { construirApp, construirServicios } from '../src/app.ts'
import { ConfigError, loadConfig } from '../src/config.ts'
import { crearMotorForUsGuide } from '../src/consulta/forusguide.ts'
import { KdError, cuerpoError } from '../src/errors.ts'

// Comprobación de disponibilidad (FORUSGUIDE_COMPROBAR_SALUD) y desafíos de la
// plataforma (cf-mitigated: challenge). ForUsGuide se sustituye con un fetch
// inyectado; ninguna prueba llama al servicio real.
const PREGUNTA = '¿Cómo hago un retiro de mi 401(k)?'
const CLAVE = 'clave-sintetica-forusguide-0123456789'
const URL_FORUSGUIDE = 'https://forusguide.invalid'

const json = (status: number, cuerpo: unknown, cabeceras: Record<string, string> = {}) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json', ...cabeceras } })
// La forma de /health observada en el servicio desplegado (valores sintéticos).
const sana = () => json(200, { status: 'healthy', version: '1.0.0', pinecone_connected: true, openai_configured: true, total_vectors: 1 })
const respondida = () => json(200, {
  answer: 'Respuesta sintética sobre retiros.', key_points: ['Punto sintético.'],
  source_articles: [{ article_id: 'retiros_401k', article_title: 'Retiros (sintético)' }],
  used_chunks: [{ chunk_id: 'retiros_401k_chunk_1', score: 0.5, chunk_type: 'steps', article_id: 'retiros_401k', article_title: 'Retiros (sintético)', content: 'Paso sintético.' }],
  confidence_note: 'well_covered', metadata: { chunks_used: 1, unique_articles: 1, model: 'modelo-sintetico', coverage_gaps: [] },
})
// Página de verificación de Cloudflare: la marca cf-mitigated, con cualquier estado.
const desafio = (status: number) => new Response('<!DOCTYPE html><html><title>Just a moment...</title><body>cloudflare</body></html>', {
  status, headers: { 'content-type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge', server: 'cloudflare', 'cf-ray': '0000000000000000-SEA' },
})

interface Llamada { metodo: string; ruta: string; cabeceras: Record<string, string> }
function motorCon(respuestas: (() => Response)[], comprobarSalud = true) {
  const estado = { reloj: 1_000_000, llamadas: [] as Llamada[], esperas: [] as number[] }
  const motor = crearMotorForUsGuide({ url: URL_FORUSGUIDE, apiKey: CLAVE, comprobarSalud }, (async (url: string | URL | Request, init?: RequestInit) => {
    estado.llamadas.push({ metodo: init?.method ?? 'GET', ruta: new URL(String(url)).pathname, cabeceras: { ...init?.headers as Record<string, string> } })
    return respuestas[estado.llamadas.length - 1]?.() ?? json(500, {})
  }) as typeof fetch, {
    ahora: () => estado.reloj,
    esperar: async ms => { estado.esperas.push(ms); estado.reloj += ms },
  })
  return { motor, estado }
}
const contexto = (signal = new AbortController().signal) => ({ requestId: 'req-0000beef', signal })
const fallo = (promesa: Promise<unknown>) => promesa.then(() => null, (error: unknown) => error as KdError)
const rutas = (llamadas: Llamada[]) => llamadas.map(llamada => `${llamada.metodo} ${llamada.ruta}`)

describe('FORUSGUIDE_COMPROBAR_SALUD: un GET /health antes de la consulta', () => {
  it('con salud JSON sana hace el GET y después el POST, en ese orden; la salud no lleva la clave', async () => {
    const { motor, estado } = motorCon([sana, respondida])
    const resultado = await motor.preguntar(PREGUNTA, contexto())
    assert.equal(resultado.respuesta, 'Respuesta sintética sobre retiros.')
    assert.deepEqual(rutas(estado.llamadas), ['GET /health', 'POST /api/v1/knowledge-question'])
    const [salud, consulta] = estado.llamadas
    assert.deepEqual(salud.cabeceras, { accept: 'application/json', 'x-correlation-id': 'req-0000beef' })
    assert.equal(consulta.cabeceras['x-api-key'], CLAVE)
  })

  it('una salud que no confirma disponibilidad detiene la consulta sin llamar al POST', async () => {
    const casos: [string, () => Response, string][] = [
      ['503', () => json(503, { error: 'http_error', message: 'Pinecone not initialized', request_id: 'sintetico' }), 'UPSTREAM_UNREACHABLE'],
      ['HTML 200', () => new Response('<html><body>OK</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'UPSTREAM_UNREACHABLE'],
      ['JSON sin status sano', () => json(200, { status: 'starting' }), 'UPSTREAM_UNREACHABLE'],
      ['JSON con MIME de texto', () => new Response('{"status":"healthy"}', { status: 200, headers: { 'content-type': 'text/plain' } }), 'UPSTREAM_UNREACHABLE'],
      ['red caída', () => { throw new TypeError('fetch failed') }, 'UPSTREAM_UNREACHABLE'],
      ['desafío 403', () => desafio(403), 'UPSTREAM_BLOCKED'],
      ['desafío 200', () => desafio(200), 'UPSTREAM_BLOCKED'],
    ]
    for (const [nombre, salud, code] of casos) {
      const { motor, estado } = motorCon([salud, respondida])
      const error = await fallo(motor.preguntar(PREGUNTA, contexto()))
      assert.ok(error instanceof KdError, nombre)
      assert.equal(error.code, code, nombre)
      assert.equal(error.details.etapa, 'salud', nombre)
      assert.equal(error.retryable, code !== 'UPSTREAM_BLOCKED', nombre)
      assert.deepEqual(rutas(estado.llamadas), ['GET /health'], `${nombre}: sin POST`)
    }
  })

  it('un 429 de la salud registra la pausa: la consulta siguiente no llama a ForUsGuide', async () => {
    const { motor, estado } = motorCon([() => json(429, {}, { 'retry-after': '30' }), sana, respondida])
    const primero = await fallo(motor.preguntar(PREGUNTA, contexto()))
    assert.deepEqual([primero?.code, primero?.details.retry_after_s], ['UPSTREAM_ERROR', 30])
    const segundo = await fallo(motor.preguntar(PREGUNTA, contexto()))
    assert.deepEqual(segundo?.diagnostico, { pausa_local: true })
    assert.deepEqual(rutas(estado.llamadas), ['GET /health'])
  })

  it('la espera de la salud respeta el plazo de la consulta: si vence, TIMEOUT y sin POST', async () => {
    let llamadas = 0
    const motor = crearMotorForUsGuide({ url: URL_FORUSGUIDE, apiKey: CLAVE, comprobarSalud: true }, ((_url: string | URL | Request, init?: RequestInit) => {
      llamadas++
      return new Promise((_resolver, rechazar) => init?.signal?.addEventListener('abort', () => rechazar(new DOMException('Tiempo agotado', 'AbortError'))))
    }) as typeof fetch)
    const vence = new AbortController()
    const consulta = fallo(motor.preguntar(PREGUNTA, contexto(vence.signal)))
    await new Promise(resolve => setImmediate(resolve))
    vence.abort()
    const error = await consulta
    assert.deepEqual([error?.code, error?.details.etapa], ['TIMEOUT', 'salud'])
    assert.equal(llamadas, 1)
  })

  it('desactivada (valor por defecto): la consulta va directa al POST, sin sondeo', async () => {
    const { motor, estado } = motorCon([respondida], false)
    await motor.preguntar(PREGUNTA, contexto())
    assert.deepEqual(rutas(estado.llamadas), ['POST /api/v1/knowledge-question'])

    const base = { KD_MODO: 'forusguide', FORUSGUIDE_API_URL: URL_FORUSGUIDE }
    assert.equal(loadConfig(base).forusguide?.comprobarSalud, false)
    assert.equal(loadConfig({ ...base, FORUSGUIDE_COMPROBAR_SALUD: 'false' }).forusguide?.comprobarSalud, false)
    assert.equal(loadConfig({ ...base, FORUSGUIDE_COMPROBAR_SALUD: 'true' }).forusguide?.comprobarSalud, true)
    assert.throws(() => loadConfig({ ...base, FORUSGUIDE_COMPROBAR_SALUD: 'si' }), ConfigError)
  })
})

describe('Desafío de la plataforma (cf-mitigated: challenge) en la consulta', () => {
  it('con cualquier estado no se reintenta ni pausa, y se informa como conexión bloqueada, no reintentable', async () => {
    for (const status of [403, 429, 503]) {
      const { motor, estado } = motorCon([() => desafio(status), respondida], false)
      const error = await fallo(motor.preguntar(PREGUNTA, contexto()))
      assert.ok(error instanceof KdError)
      assert.deepEqual([error.code, error.retryable, error.details.upstream_status], ['UPSTREAM_BLOCKED', false, status])
      assert.deepEqual(estado.esperas, [], 'sin espera ni reintento')
      const { intentos } = error.diagnostico as { intentos: { cabeceras: Record<string, string>; cuerpo: { clase: string } }[] }
      assert.deepEqual([intentos[0].cabeceras['cf-mitigated'], intentos[0].cabeceras['cf-ray'], intentos[0].cuerpo.clase], ['challenge', '0000000000000000-SEA', 'html'])
      assert.doesNotMatch(JSON.stringify(cuerpoError(error, 'req-0000beef')), /challenge|cf-ray|cloudflare|Just a moment/)
      // No deja una pausa: la consulta siguiente sí llega a ForUsGuide.
      assert.equal((await motor.preguntar(PREGUNTA, contexto())).generada, true, String(status))
      assert.equal(estado.llamadas.length, 2)
    }
  })

  it('un desafío en el reintento tras un 429 tampoco se reintenta', async () => {
    const { motor, estado } = motorCon([() => json(429, {}, { 'retry-after': '2' }), () => desafio(429), respondida], false)
    const error = await fallo(motor.preguntar(PREGUNTA, contexto()))
    assert.equal(error?.code, 'UPSTREAM_BLOCKED')
    assert.deepEqual(estado.esperas, [2000])
    assert.equal(estado.llamadas.length, 2)
  })
})

describe('Contrato y registro con la comprobación activada desde la configuración', () => {
  it('salud sana y POST con desafío: 502 UPSTREAM_BLOCKED sin cabeceras ni cuerpo en la respuesta; el CF-Ray queda en el registro', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kd-forusguide-disponibilidad-'))
    const config = loadConfig({
      KD_MODO: 'forusguide', FORUSGUIDE_API_URL: URL_FORUSGUIDE, FORUSGUIDE_API_KEY: CLAVE, FORUSGUIDE_COMPROBAR_SALUD: 'true',
      KD_DATA_DIR: path.join(dir, 'datos'), KD_UI_DIST: path.join(dir, 'sin-ui'),
    })
    const llamadas: string[] = []
    const fetchForUsGuide = (async (url: string | URL | Request, init?: RequestInit) => {
      const ruta = new URL(String(url)).pathname
      llamadas.push(`${init?.method ?? 'GET'} ${ruta}`)
      return ruta === '/health' ? sana() : desafio(429)
    }) as typeof fetch
    const lineas: string[] = []
    const app = await construirApp(await construirServicios(config, { fetchForUsGuide }), { destinoLog: { write: linea => { lineas.push(linea) } } })
    try {
      const respuesta = await app.inject({ method: 'POST', url: '/api/consulta', headers: { 'x-request-id': 'req-8555761c' }, payload: { question: PREGUNTA } })
      assert.equal(respuesta.statusCode, 502)
      const cuerpo = respuesta.json()
      assert.equal(cuerpo.code, 'UPSTREAM_BLOCKED')
      assert.deepEqual(cuerpo.details, { retryable: false, upstream_status: 429 })
      assert.match(cuerpo.message, /Avisa al administrador con el ID de soporte/)
      assert.doesNotMatch(respuesta.body, /challenge|cf-ray|0000000000000000|cloudflare/)
      assert.deepEqual(llamadas, ['GET /health', 'POST /api/v1/knowledge-question'])
      const aviso = lineas.map(linea => JSON.parse(linea)).find(linea => linea.msg === 'respuesta externa no satisfactoria')
      assert.equal(aviso?.reqId, 'req-8555761c')
      assert.equal(aviso?.externo.intentos[0].cabeceras['cf-ray'], '0000000000000000-SEA')
      assert.doesNotMatch(lineas.join(''), /clave-sintetica|retiro de mi 401|Just a moment/)
    } finally {
      await app.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
