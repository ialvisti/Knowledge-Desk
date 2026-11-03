import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { construirApp, construirServicios } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { crearMotorForUsGuide } from '../src/consulta/forusguide.ts'
import { KdError, cuerpoError } from '../src/errors.ts'

// Caso reportado el 2026-11-03: «¿Cómo hago un retiro de mi 401(k)?» recibió de
// ForUsGuide un 429 (req-b55f0da9), y la misma pregunta se respondió con
// normalidad poco después. ForUsGuide se sustituye con un fetch inyectado; nunca
// se llama al servicio real.
const PREGUNTA = '¿Cómo hago un retiro de mi 401(k)?'
const CONFIG = { url: 'https://forusguide.invalid', apiKey: 'clave-sintetica-forusguide-0123456789' }

const json = (status: number, cuerpo: unknown, cabeceras: Record<string, string> = {}) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json', ...cabeceras } })
const limitada = (retryAfter?: string) =>
  json(429, { error: 'http_error', message: 'Too Many Requests', request_id: 'sintetico' }, retryAfter === undefined ? {} : { 'retry-after': retryAfter })
const respondida = () => json(200, {
  answer: 'Respuesta sintética sobre retiros.', key_points: ['Punto sintético.'],
  source_articles: [{ article_id: 'retiros_401k', article_title: 'Retiros (sintético)' }],
  used_chunks: [{ chunk_id: 'retiros_401k_chunk_1', score: 0.5, chunk_type: 'steps', article_id: 'retiros_401k', article_title: 'Retiros (sintético)', content: 'Paso sintético.' }],
  confidence_note: 'well_covered', metadata: { chunks_used: 1, unique_articles: 1, model: 'modelo-sintetico', coverage_gaps: [] },
})
// 429 generado delante de la app (sin x-request-id ni x-render-origin-server),
// sin Retry-After, como los observados desde Render el 2026-11-03.
const CABECERAS_PLATAFORMA = { server: 'cloudflare', 'cf-ray': '0000000000000000-PDX', 'content-type': 'text/plain; charset=UTF-8' }
const dePlataforma = (extra: Record<string, string> = {}) => new Response('error code: 1015', { status: 429, headers: { ...CABECERAS_PLATAFORMA, ...extra } })
// Lo que queda en el registro: el MIME sin parámetros y solo la clase del cuerpo.
const REGISTRO_PLATAFORMA = { cabeceras: { ...CABECERAS_PLATAFORMA, 'content-type': 'text/plain' }, cuerpo: { clase: 'cloudflare_1015', bytes: 16, truncado: false, menciona_cloudflare: false, menciona_render: false } }

// Motor con reloj y esperas simulados: cuenta las llamadas a ForUsGuide y anota cada espera.
function motorCon(respuestas: (() => Response)[]) {
  const estado = { reloj: 1_000_000, llamadas: 0, esperas: [] as number[] }
  const motor = crearMotorForUsGuide(CONFIG, (async () => respuestas[estado.llamadas++]?.() ?? json(500, {})) as typeof fetch, {
    ahora: () => estado.reloj,
    esperar: async ms => { estado.esperas.push(ms); estado.reloj += ms },
  })
  return { motor, estado }
}
const contexto = (signal = new AbortController().signal) => ({ requestId: 'req-0000beef', signal })
const esLimite = (segundos: number) => (error: unknown) =>
  error instanceof KdError && error.code === 'UPSTREAM_ERROR' && error.details.upstream_status === 429 && error.details.retry_after_s === segundos

describe('ForUsGuide 429: limitación temporal con Retry-After, sin tormenta de reintentos', () => {
  it('caso reportado: un 429 breve se reintenta una vez tras Retry-After y la consulta se responde', async () => {
    const { motor, estado } = motorCon([() => limitada('2'), respondida])
    const resultado = await motor.preguntar(PREGUNTA, contexto())
    assert.equal(resultado.respuesta, 'Respuesta sintética sobre retiros.')
    assert.equal(estado.llamadas, 2)
    assert.deepEqual(estado.esperas, [2000])
  })

  it('si el límite persiste, se informa con su espera después de un único reintento', async () => {
    const { motor, estado } = motorCon([() => limitada('3'), () => limitada('3'), respondida])
    await assert.rejects(motor.preguntar(PREGUNTA, contexto()), esLimite(3))
    assert.equal(estado.llamadas, 2)
    assert.deepEqual(estado.esperas, [3000])
  })

  it('una espera larga no se reintenta y, mientras dura, ninguna consulta llama a ForUsGuide', async () => {
    const { motor, estado } = motorCon([() => limitada('30'), respondida])
    await assert.rejects(motor.preguntar(PREGUNTA, contexto()), esLimite(30))
    assert.equal(estado.llamadas, 1)
    assert.deepEqual(estado.esperas, [])
    estado.reloj += 12_000
    await assert.rejects(motor.preguntar(PREGUNTA, contexto()), esLimite(18))
    await assert.rejects(motor.articulo!('retiros_401k', contexto()), esLimite(18))
    assert.equal(estado.llamadas, 1, 'durante la pausa no sale ninguna solicitud')
    estado.reloj += 18_000
    assert.equal((await motor.preguntar(PREGUNTA, contexto())).generada, true)
    assert.equal(estado.llamadas, 2)
  })

  it('sin Retry-After, o con un valor no válido o no representable, espera 5 s; acepta la fecha HTTP', async () => {
    for (const valor of [undefined, '', '2.5', '-3', '1e3', 'pronto', '9'.repeat(400), '99999999999999999', 'Sun, 99 Xyz 2026 99:99:99 GMT']) {
      const { motor, estado } = motorCon([() => limitada(valor), respondida])
      await motor.preguntar(PREGUNTA, contexto())
      assert.deepEqual(estado.esperas, [5000], `Retry-After: ${String(valor).slice(0, 20)}`)
    }
    const conFecha = motorCon([() => limitada(new Date(1_000_000 + 4_000).toUTCString()), respondida])
    await conFecha.motor.preguntar(PREGUNTA, contexto())
    assert.deepEqual(conFecha.estado.esperas, [4000])
  })

  it('un Retry-After largo se respeta completo, sin espera automática ni recorte', async () => {
    for (const segundos of [3600, 86400]) {
      const { motor, estado } = motorCon([() => limitada(String(segundos)), respondida])
      await assert.rejects(motor.preguntar(PREGUNTA, contexto()), esLimite(segundos))
      assert.deepEqual(estado.esperas, [])
      estado.reloj += (segundos - 1) * 1000
      await assert.rejects(motor.preguntar(PREGUNTA, contexto()), esLimite(1))
      assert.equal(estado.llamadas, 1, 'durante todo el plazo no sale ninguna solicitud')
      estado.reloj += 1000
      assert.equal((await motor.preguntar(PREGUNTA, contexto())).generada, true)
    }
    const conFecha = motorCon([() => limitada(new Date(1_000_000 + 86_400_000).toUTCString())])
    await assert.rejects(conFecha.motor.preguntar(PREGUNTA, contexto()), esLimite(86400))
  })

  it('libera el cuerpo de cada 429, aunque liberarlo falle o no termine', async () => {
    let canceladas = 0
    const conCuerpo = (retryAfter: string, cancel: () => void | Promise<void> = () => { canceladas++ }) =>
      new Response(new ReadableStream({ cancel }), { status: 429, headers: { 'retry-after': retryAfter } })
    const { motor, estado } = motorCon([() => conCuerpo('2'), () => conCuerpo('2')])
    const esperas: number[] = []
    const vigilado = crearMotorForUsGuide(CONFIG, (async () => conCuerpo('2')) as typeof fetch, {
      ahora: () => estado.reloj,
      esperar: async () => { esperas.push(canceladas) },
    })
    await assert.rejects(vigilado.preguntar(PREGUNTA, contexto()), esLimite(2))
    assert.deepEqual(esperas, [1], 'el primer cuerpo se libera antes de esperar')
    assert.equal(canceladas, 2, 'y el segundo antes de informar el límite')
    await assert.rejects(motor.preguntar(PREGUNTA, contexto()), esLimite(2))
    assert.equal(canceladas, 4)

    // Un cuerpo que falla al liberarse, o cuya liberación nunca termina, no
    // cambia el error ni lo retrasa.
    for (const cancel of [() => { throw new Error('no se libera') }, () => new Promise<void>(() => {})]) {
      const rebelde = motorCon([() => conCuerpo('30', cancel)])
      await assert.rejects(rebelde.motor.preguntar(PREGUNTA, contexto()), esLimite(30))
    }
  })

  it('si el tiempo de la consulta se agota durante la espera, es TIMEOUT y no se reintenta', async () => {
    let llamadas = 0
    const motor = crearMotorForUsGuide(CONFIG, (async () => { llamadas++; return limitada('5') }) as typeof fetch)
    await assert.rejects(motor.preguntar(PREGUNTA, contexto(AbortSignal.timeout(50))), (error: unknown) => error instanceof KdError && error.code === 'TIMEOUT')
    assert.equal(llamadas, 1)
  })

  it('adjunta para el registro quién generó cada 429 (estado, ms y cabeceras de origen), fuera del contrato', async () => {
    const { motor } = motorCon([() => dePlataforma(), () => dePlataforma()])
    const error = await motor.preguntar(PREGUNTA, contexto()).then(() => null, (fallo: unknown) => fallo)
    assert.ok(error instanceof KdError && esLimite(5)(error))
    const { intentos } = error.diagnostico as { intentos: { estado: number; ms: number; cabeceras: unknown; cuerpo: unknown }[] }
    assert.deepEqual(intentos.map(({ estado, cabeceras, cuerpo }) => ({ estado, cabeceras, cuerpo })), [{ estado: 429, ...REGISTRO_PLATAFORMA }, { estado: 429, ...REGISTRO_PLATAFORMA }])
    assert.ok(intentos.every(intento => Number.isInteger(intento.ms) && intento.ms >= 0))
    assert.doesNotMatch(JSON.stringify(cuerpoError(error, 'req-0000beef')), /cloudflare|cf-ray|intentos|1015/)

    // Durante la pausa no sale ninguna llamada, y el registro lo distingue.
    const enPausa = await motor.preguntar(PREGUNTA, contexto()).then(() => null, (fallo: unknown) => fallo)
    assert.ok(enPausa instanceof KdError)
    assert.deepEqual(enPausa.diagnostico, { pausa_local: true })
  })

  it('omite del registro los valores de cabecera mal formados o que contienen la clave del servidor', async () => {
    const { motor } = motorCon([() => new Response(null, {
      status: 429,
      headers: {
        server: CONFIG.apiKey, // formato válido, pero es la clave
        'x-render-origin-server': 'sintetica-forusguide', // un fragmento de la clave
        'rndr-id': 'no es un id <script>',
        'cf-ray': `${CONFIG.apiKey}-PDX`,
        'cf-mitigated': 'challenge',
        'x-request-id': `clave=${CONFIG.apiKey}`,
        'content-type': 'Text/HTML; charset=utf-8',
        'content-length': '12abc',
        'retry-after': '30',
      },
    })])
    const error = await motor.preguntar(PREGUNTA, contexto()).then(() => null, (fallo: unknown) => fallo)
    assert.ok(error instanceof KdError)
    const { intentos } = error.diagnostico as { intentos: { cabeceras: unknown }[] }
    assert.deepEqual(intentos[0].cabeceras, { 'cf-mitigated': 'challenge', 'content-type': 'text/html', 'retry-after': '30' })
    assert.doesNotMatch(JSON.stringify(error.diagnostico), /clave|sintetica|script/)
  })

  it('clasifica el cuerpo del 429 sin registrar su texto, con lectura acotada', async () => {
    const PRIVADO = `${PREGUNTA} ${CONFIG.apiKey}`
    const JSON_MIME = { 'content-type': 'application/json' }
    const HTML_MIME = { 'content-type': 'text/html' }
    const casos: [string | null, Record<string, string>, string][] = [
      [JSON.stringify({ error: 'http_error', message: PRIVADO, request_id: 'sintetico' }), JSON_MIME, 'json_app'],
      [JSON.stringify({ detail: PRIVADO }), JSON_MIME, 'json_app'],
      [JSON.stringify({ title: 'Error 1015: You are being rate limited', error_code: 1015, detail: PRIVADO }), JSON_MIME, 'cloudflare_1015'],
      [JSON.stringify({ otro: PRIVADO }), JSON_MIME, 'json_otro'],
      [`<!DOCTYPE html><html><title>Service waking up</title><body>Render ${PRIVADO}</body></html>`, HTML_MIME, 'render'],
      [`<html><body>Too Many Requests ${PRIVADO}</body></html>`, HTML_MIME, 'html'],
      [null, {}, 'vacio'],
    ]
    for (const [cuerpo, cabeceras, clase] of casos) {
      const { motor } = motorCon([() => new Response(cuerpo, { status: 429, headers: { 'retry-after': '30', ...cabeceras } })])
      const error = await motor.preguntar(PREGUNTA, contexto()).then(() => null, (fallo: unknown) => fallo)
      assert.ok(error instanceof KdError)
      const { intentos } = error.diagnostico as { intentos: { cuerpo: { clase: string } }[] }
      assert.equal(intentos[0].cuerpo.clase, clase, clase)
      assert.doesNotMatch(JSON.stringify(error.diagnostico), /retiro|clave|rate limited|waking|Too Many/, clase)
    }

    // Un único fragmento enorme se recorta a 2048 bytes; uno de 2048 justos no se marca truncado.
    const deUnFragmento = (bytes: number) => new Response(new ReadableStream({
      start(controlador) { controlador.enqueue(new Uint8Array(bytes).fill(120)); controlador.close() },
    }), { status: 429, headers: { 'retry-after': '30' } })
    for (const [enviados, truncado] of [[50_000, true], [2048, false]] as const) {
      const { motor } = motorCon([() => deUnFragmento(enviados)])
      const error = await motor.preguntar(PREGUNTA, contexto()).then(() => null, (fallo: unknown) => fallo) as KdError
      const { cuerpo } = (error.diagnostico as { intentos: { cuerpo: { bytes: number; truncado: boolean } }[] }).intentos[0]
      assert.deepEqual({ bytes: cuerpo.bytes, truncado: cuerpo.truncado }, { bytes: 2048, truncado }, String(enviados))
    }
    // Un cuerpo que nunca termina no retiene el error.
    const inicio = performance.now()
    const colgado = motorCon([() => new Response(new ReadableStream(), { status: 429, headers: { 'retry-after': '30' } })])
    const sinFin = await colgado.motor.preguntar(PREGUNTA, contexto()).then(() => null, (fallo: unknown) => fallo) as KdError
    assert.ok(esLimite(30)(sinFin))
    assert.equal((sinFin.diagnostico as { intentos: { cuerpo: { clase: string } }[] }).intentos[0].cuerpo.clase, 'no_leido')
    assert.ok(performance.now() - inicio < 2000, 'la lectura está acotada en el tiempo')
  })

  it('los demás errores de ForUsGuide no se reintentan', async () => {
    for (const status of [401, 422, 500, 502, 503]) {
      const { motor, estado } = motorCon([() => json(status, { error: 'http_error' }), respondida])
      await assert.rejects(motor.preguntar(PREGUNTA, contexto()), KdError)
      assert.equal(estado.llamadas, 1, String(status))
    }
  })
})

interface Diferido<T> { promesa: Promise<T>; resolver: (valor: T) => void; rechazar: (error: unknown) => void }
function diferido<T>(): Diferido<T> {
  let resolver!: (valor: T) => void
  let rechazar!: (error: unknown) => void
  const promesa = new Promise<T>((si, no) => { resolver = si; rechazar = no })
  return { promesa, resolver, rechazar }
}

// Motor cuyas llamadas a ForUsGuide y esperas quedan pendientes hasta que la
// prueba las resuelve: la concurrencia es real y el orden, determinista.
function motorControlado() {
  const estado = { reloj: 1_000_000, envios: [] as Diferido<Response>[], esperas: [] as { ms: number; fin: Diferido<void> }[] }
  const motor = crearMotorForUsGuide(CONFIG, (() => {
    const envio = diferido<Response>()
    estado.envios.push(envio)
    return envio.promesa
  }) as typeof fetch, {
    ahora: () => estado.reloj,
    esperar: ms => {
      const fin = diferido<void>()
      estado.esperas.push({ ms, fin })
      return fin.promesa
    },
  })
  return { motor, estado }
}
// Resultado observable de una consulta sin esperarla.
function seguir(promesa: Promise<unknown>) {
  const seguida: { listo: boolean; error?: unknown; promesa: Promise<void> } = { listo: false, promesa: Promise.resolve() }
  seguida.promesa = promesa.then(() => { seguida.listo = true }, error => { seguida.error = error; seguida.listo = true })
  return seguida
}
// Deja correr todas las continuaciones pendientes (microtareas), sin esperas de tiempo.
const drenar = () => new Promise(resolve => setImmediate(resolve))

describe('ForUsGuide 429 con consultas concurrentes: un solo reintento de recuperación', () => {
  it('varias consultas en vuelo que reciben 429 a la vez: solo una reintenta y las demás reciben su espera', async () => {
    const { motor, estado } = motorControlado()
    const consultas = [1, 2, 3].map(() => seguir(motor.preguntar(PREGUNTA, contexto())))
    await drenar()
    assert.equal(estado.envios.length, 3)
    for (const envio of estado.envios) envio.resolver(limitada('2'))
    await drenar()
    assert.equal(estado.esperas.length, 1, 'una sola espera de recuperación')
    assert.equal(estado.esperas[0].ms, 2000)
    const informadas = consultas.filter(consulta => consulta.listo)
    assert.equal(informadas.length, 2)
    for (const consulta of informadas) assert.ok(esLimite(2)(consulta.error))

    estado.reloj += 2000
    estado.esperas[0].fin.resolver()
    await drenar()
    assert.equal(estado.envios.length, 4, 'un único reintento')
    estado.envios[3].resolver(respondida())
    await Promise.all(consultas.map(consulta => consulta.promesa))
    assert.equal(consultas.filter(consulta => consulta.error === undefined).length, 1)
  })

  it('si otra respuesta amplía la pausa durante la espera, no se reintenta y la reserva se libera', async () => {
    const { motor, estado } = motorControlado()
    const primera = seguir(motor.preguntar(PREGUNTA, contexto()))
    const segunda = seguir(motor.preguntar(PREGUNTA, contexto()))
    await drenar()
    estado.envios[0].resolver(limitada('2'))
    await drenar()
    assert.equal(estado.esperas.length, 1)
    estado.envios[1].resolver(limitada('30'))
    await drenar()
    assert.ok(esLimite(30)(segunda.error))

    estado.reloj += 2000
    estado.esperas[0].fin.resolver()
    await drenar()
    assert.ok(esLimite(28)(primera.error))
    assert.equal(estado.envios.length, 2, 'sin reintento dentro de la pausa ampliada')

    // Pasada la pausa, la reserva está libre: un nuevo 429 breve vuelve a reintentar.
    estado.reloj += 28_000
    const tercera = seguir(motor.preguntar(PREGUNTA, contexto()))
    await drenar()
    estado.envios[2].resolver(limitada('1'))
    await drenar()
    assert.equal(estado.esperas.length, 2)
    estado.reloj += 1000
    estado.esperas[1].fin.resolver()
    await drenar()
    estado.envios[3].resolver(respondida())
    await tercera.promesa
    assert.equal(tercera.error, undefined)
  })

  it('si la espera despierta tarde, cuando la pausa ampliada ya venció, el reintento reservado sigue', async () => {
    const { motor, estado } = motorControlado()
    const primera = seguir(motor.preguntar(PREGUNTA, contexto()))
    const segunda = seguir(motor.preguntar(PREGUNTA, contexto()))
    await drenar()
    estado.envios[0].resolver(limitada('2'))
    await drenar()
    estado.envios[1].resolver(limitada('5'))
    await drenar()
    assert.ok(esLimite(5)(segunda.error))

    // El temporizador despierta a los 6 s: la pausa ampliada (5 s) ya venció.
    estado.reloj += 6000
    estado.esperas[0].fin.resolver()
    await drenar()
    assert.equal(estado.envios.length, 3, 'el reintento reservado sale')
    estado.envios[2].resolver(respondida())
    await primera.promesa
    assert.equal(primera.error, undefined)
  })

  it('la pausa del 429 rige desde sus cabeceras: mientras se lee su cuerpo, otra consulta no llama a ForUsGuide', async () => {
    const { motor, estado } = motorControlado()
    let cuerpo!: ReadableStreamDefaultController<Uint8Array>
    const primera = seguir(motor.preguntar(PREGUNTA, contexto()))
    await drenar()
    estado.envios[0].resolver(new Response(new ReadableStream<Uint8Array>({ start(controlador) { cuerpo = controlador } }), { status: 429, headers: { 'retry-after': '30' } }))
    await drenar()
    assert.equal(primera.listo, false, 'el cuerpo sigue pendiente')
    const segunda = seguir(motor.preguntar(PREGUNTA, contexto()))
    await drenar()
    assert.ok(esLimite(30)(segunda.error))
    assert.deepEqual((segunda.error as KdError).diagnostico, { pausa_local: true })
    assert.equal(estado.envios.length, 1, 'sin llamada extra durante la lectura')
    cuerpo.close()
    await primera.promesa
    assert.ok(esLimite(30)(primera.error))
  })

  it('si la consulta vence mientras se lee el cuerpo del primer o del segundo 429, es TIMEOUT y la pausa queda registrada', async () => {
    const { motor, estado } = motorControlado()
    const vence = new AbortController()
    const primera = seguir(motor.preguntar(PREGUNTA, contexto(vence.signal)))
    await drenar()
    estado.envios[0].resolver(new Response(new ReadableStream(), { status: 429, headers: { 'retry-after': '30' } }))
    await drenar()
    vence.abort()
    await primera.promesa
    assert.ok(primera.error instanceof KdError && primera.error.code === 'TIMEOUT')
    assert.ok(esLimite(30)(await motor.preguntar(PREGUNTA, contexto()).then(() => null, (fallo: unknown) => fallo)))
    assert.equal(estado.envios.length, 1)

    const venceEnReintento = new AbortController()
    const reintento = motorCon([() => limitada('2'), () => {
      venceEnReintento.abort()
      return new Response(new ReadableStream(), { status: 429, headers: { 'retry-after': '30' } })
    }])
    const error = await reintento.motor.preguntar(PREGUNTA, contexto(venceEnReintento.signal)).then(() => null, (fallo: unknown) => fallo)
    assert.ok(error instanceof KdError && error.code === 'TIMEOUT')
    assert.deepEqual(reintento.estado.esperas, [2000])
    assert.ok(esLimite(30)(await reintento.motor.preguntar(PREGUNTA, contexto()).then(() => null, (fallo: unknown) => fallo)))
    assert.equal(reintento.estado.llamadas, 2)
  })

  it('la reserva se libera si la espera termina en TIMEOUT o el reintento falla', async () => {
    const { motor, estado } = motorControlado()
    const agotada = seguir(motor.preguntar(PREGUNTA, contexto()))
    await drenar()
    estado.envios[0].resolver(limitada('2'))
    await drenar()
    estado.esperas[0].fin.rechazar(new DOMException('Tiempo agotado', 'AbortError'))
    await drenar()
    assert.ok(agotada.error instanceof KdError && agotada.error.code === 'TIMEOUT')

    estado.reloj += 2000
    const caida = seguir(motor.preguntar(PREGUNTA, contexto()))
    await drenar()
    estado.envios[1].resolver(limitada('2'))
    await drenar()
    assert.equal(estado.esperas.length, 2, 'tras el TIMEOUT otra consulta puede reintentar')
    estado.reloj += 2000
    estado.esperas[1].fin.resolver()
    await drenar()
    estado.envios[2].rechazar(new TypeError('fetch failed'))
    await drenar()
    assert.ok(caida.error instanceof KdError && caida.error.code === 'UPSTREAM_UNREACHABLE')

    const siguiente = seguir(motor.preguntar(PREGUNTA, contexto()))
    await drenar()
    estado.envios[3].resolver(limitada('2'))
    await drenar()
    assert.equal(estado.esperas.length, 3, 'tras el fallo del reintento otra consulta puede reintentar')
    estado.reloj += 2000
    estado.esperas[2].fin.resolver()
    await drenar()
    estado.envios[4].resolver(respondida())
    await siguiente.promesa
    assert.equal(siguiente.error, undefined)
  })
})

describe('Contrato de /api/consulta ante un 429 persistente de ForUsGuide', () => {
  it('responde UPSTREAM_ERROR con upstream_status y retry_after_s sin reenviar el cuerpo de ForUsGuide, y no lo vuelve a llamar durante la pausa', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kd-forusguide-limite-'))
    const config = loadConfig({
      KD_MODO: 'forusguide', FORUSGUIDE_API_URL: CONFIG.url, FORUSGUIDE_API_KEY: CONFIG.apiKey,
      KD_DATA_DIR: path.join(dir, 'datos'), KD_UI_DIST: path.join(dir, 'sin-ui'),
    })
    let llamadas = 0
    const fetchForUsGuide = (async () => { llamadas++; return limitada('30') }) as typeof fetch
    const app = await construirApp(await construirServicios(config, { fetchForUsGuide }), { logger: false })
    try {
      const respuesta = await app.inject({ method: 'POST', url: '/api/consulta', headers: { 'x-request-id': 'req-b55f0da9' }, payload: { question: PREGUNTA } })
      assert.equal(respuesta.statusCode, 502)
      const cuerpo = respuesta.json()
      assert.equal(cuerpo.status, 'error')
      assert.equal(cuerpo.code, 'UPSTREAM_ERROR')
      assert.deepEqual(cuerpo.details, { retryable: true, upstream_status: 429, retry_after_s: 30 })
      assert.equal(cuerpo.request_id, 'req-b55f0da9')
      assert.match(cuerpo.message, /limitando las solicitudes\. Inténtalo de nuevo en 30 segundos/)
      assert.doesNotMatch(respuesta.body, /Too Many Requests|forusguide\.invalid|clave-sintetica/)

      // «Reintentar» durante la pausa responde enseguida, sin otra llamada a ForUsGuide.
      const reintento = (await app.inject({ method: 'POST', url: '/api/consulta', payload: { question: PREGUNTA } })).json()
      assert.equal(reintento.code, 'UPSTREAM_ERROR')
      assert.ok(reintento.details.retry_after_s >= 1 && reintento.details.retry_after_s <= 30)
      assert.equal(llamadas, 1)
    } finally {
      await app.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('el registro del servidor anota el origen del 429 con el ID de soporte, sin clave, pregunta ni cuerpo', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kd-forusguide-registro-'))
    const config = loadConfig({
      KD_MODO: 'forusguide', FORUSGUIDE_API_URL: CONFIG.url, FORUSGUIDE_API_KEY: CONFIG.apiKey,
      KD_DATA_DIR: path.join(dir, 'datos'), KD_UI_DIST: path.join(dir, 'sin-ui'),
    })
    const fetchForUsGuide = (async () => dePlataforma({ 'retry-after': '30' })) as typeof fetch
    const lineas: string[] = []
    const app = await construirApp(await construirServicios(config, { fetchForUsGuide }), { destinoLog: { write: linea => { lineas.push(linea) } } })
    try {
      const respuesta = await app.inject({ method: 'POST', url: '/api/consulta', headers: { 'x-request-id': 'req-759377e8' }, payload: { question: PREGUNTA } })
      assert.equal(respuesta.json().code, 'UPSTREAM_ERROR')
      assert.doesNotMatch(respuesta.body, /cloudflare|cf-ray|1015/)
      const aviso = lineas.map(linea => JSON.parse(linea)).find(linea => linea.msg === 'respuesta externa no satisfactoria')
      assert.ok(aviso, 'el 429 queda registrado')
      assert.equal(aviso.reqId, 'req-759377e8')
      assert.equal(aviso.level, 40)
      assert.deepEqual(aviso.externo.intentos.map(({ estado, cabeceras, cuerpo }: Record<string, unknown>) => ({ estado, cabeceras, cuerpo })), [
        { estado: 429, cabeceras: { ...REGISTRO_PLATAFORMA.cabeceras, 'retry-after': '30' }, cuerpo: REGISTRO_PLATAFORMA.cuerpo },
      ])
      assert.doesNotMatch(lineas.join(''), /clave-sintetica|retiro de mi 401|error code/)
    } finally {
      await app.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
