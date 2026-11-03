import { setTimeout as dormir } from 'node:timers/promises'
import type { ForUsGuideConfig } from '../config.ts'
import { KdError } from '../errors.ts'
import type { ArticuloCompleto, ContextoConsulta, Evidencia, Motor, ResultadoMotor } from './motor.ts'

type FetchImpl = typeof fetch

// Inyectables en las pruebas: el reloj y la espera antes de reintentar.
export interface OpcionesForUsGuide {
  ahora?: () => number
  esperar?: (ms: number, signal: AbortSignal) => Promise<unknown>
}

// Un 429 de ForUsGuide (o de la plataforma que lo publica) limita solicitudes
// por un tiempo; no indica que el servicio esté caído. Se respeta Retry-After
// completo: mientras dure, este servidor no vuelve a llamarlo, y solo si la
// espera es breve una única consulta reintenta. Así los reintentos no alimentan
// el límite.
const ESPERA_SIN_INDICACION_S = 5
const MAX_ESPERA_REINTENTO_S = 10

const FECHA_HTTP = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/

// Retry-After admite segundos o una fecha HTTP (IMF-fixdate). Un valor que no
// cumple el formato o que no se representa con exactitud en milisegundos se
// trata como ausente.
function segundosRetryAfter(valor: string | null, ahora: number): number | null {
  const texto = valor?.trim() ?? ''
  let segundos: number
  if (/^\d+$/.test(texto)) segundos = Number(texto)
  else if (FECHA_HTTP.test(texto)) segundos = Math.ceil((Date.parse(texto) - ahora) / 1000)
  else return null
  return Number.isSafeInteger(segundos * 1000) ? segundos : null
}

function errorPorLimite(segundos: number, diagnostico: Record<string, unknown>): KdError {
  const espera = segundos === 1 ? '1 segundo' : `${segundos} segundos`
  const error = new KdError('UPSTREAM_ERROR', `El servicio de consulta está limitando las solicitudes. Inténtalo de nuevo en ${espera}.`, { upstream_status: 429, retry_after_s: segundos })
  error.diagnostico = diagnostico
  return error
}

// Diagnóstico de un 429 para el registro del servidor (nunca para el contrato).
// Las cabeceras muestran por dónde pasó la respuesta: la app de ForUsGuide pone
// su x-request-id (uuid) y x-render-origin-server: uvicorn; Render, rndr-id;
// Cloudflare, cf-ray. Un valor que no cumple su formato, o que contiene la clave
// del servidor, se omite.
const FORMATOS_DE_ORIGEN: Record<string, RegExp> = {
  server: /^[A-Za-z0-9._ /-]{1,40}$/,
  'x-render-origin-server': /^[A-Za-z0-9._ /-]{1,40}$/,
  'rndr-id': /^[0-9a-f-]{8,64}$/i,
  'cf-ray': /^[0-9a-f]{8,32}(?:-[A-Z]{3})?$/,
  'cf-mitigated': /^[a-z_]{1,20}$/,
  'x-request-id': /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'content-type': /^[a-z]+\/[a-z0-9.+-]{1,60}$/,
  'content-length': /^\d{1,9}$/,
  'retry-after': /^\d{1,10}$/,
}

function cabecerasDeOrigen(respuesta: Response, clave: string | null): Record<string, string> {
  const reflejaClave = (valor: string) => clave !== null && (valor.includes(clave) || (valor.length >= 8 && clave.includes(valor)))
  return Object.fromEntries(Object.entries(FORMATOS_DE_ORIGEN).flatMap(([nombre, formato]) => {
    let valor = respuesta.headers.get(nombre)?.trim() ?? ''
    if (nombre === 'content-type') valor = valor.split(';')[0].trim().toLowerCase()
    const valido = formato.test(valor) || (nombre === 'retry-after' && FECHA_HTTP.test(valor))
    return valido && !reflejaClave(valor) ? [[nombre, valor]] : []
  }))
}

// El cuerpo se lee como mucho MAX_MUESTRA_BYTES durante MAX_LECTURA_MS (o hasta
// que venza la consulta), y siempre se libera. Solo se registra a qué clase
// pertenece; nunca su texto.
const MAX_MUESTRA_BYTES = 2048
const MAX_LECTURA_MS = 300

async function leerMuestra(respuesta: Response, signal: AbortSignal) {
  const lector = respuesta.body?.getReader()
  if (!lector) return { texto: '', bytes: 0, completa: true, aTiempo: true }
  const partes: Uint8Array[] = []
  let bytes = 0
  let completa = false
  let aTiempo = true
  let temporizador: ReturnType<typeof setTimeout> | undefined
  let cortar = () => {}
  const corte = new Promise<'corte'>(resolve => {
    cortar = () => resolve('corte')
    temporizador = setTimeout(cortar, MAX_LECTURA_MS)
    if (signal.aborted) cortar()
    else signal.addEventListener('abort', cortar, { once: true })
  })
  try {
    while (true) {
      const lectura = await Promise.race([lector.read(), corte])
      if (lectura === 'corte') { aTiempo = false; break }
      if (lectura.done) { completa = true; break }
      // Un fragmento que no cabe se recorta (copia) al espacio restante.
      const resto = MAX_MUESTRA_BYTES - bytes
      if (lectura.value.byteLength > resto) {
        partes.push(lectura.value.slice(0, resto))
        bytes += resto
        break
      }
      partes.push(lectura.value)
      bytes += lectura.value.byteLength
    }
  } catch { /* cuerpo interrumpido: se clasifica lo leído */ } finally {
    clearTimeout(temporizador)
    signal.removeEventListener('abort', cortar)
    // En undici, un cuerpo pendiente retiene la conexión. La liberación no se
    // espera, y si falla no tapa el error de límite.
    try {
      void lector.cancel().catch(() => {})
    } catch { /* el error de límite es lo que se informa */ }
  }
  const unido = new Uint8Array(bytes)
  let desplazamiento = 0
  for (const parte of partes) { unido.set(parte, desplazamiento); desplazamiento += parte.byteLength }
  return { texto: new TextDecoder().decode(unido), bytes, completa, aTiempo }
}

const esErrorDeLaApp = (valor: unknown) => typeof valor === 'object' && valor !== null && !Array.isArray(valor)
  && Object.keys(valor).every(clave => ['error', 'message', 'request_id', 'detail'].includes(clave))
  && ('error' in valor || 'detail' in valor)

async function clasificarCuerpo(respuesta: Response, signal: AbortSignal) {
  const { texto, bytes, completa, aTiempo } = await leerMuestra(respuesta, signal)
  const muestra = texto.toLowerCase()
  let json: unknown
  if (completa) {
    try { json = JSON.parse(texto) } catch { /* no es JSON */ }
  }
  const mencionaRender = /\brender\b/.test(muestra)
  let clase: 'cloudflare_1015' | 'json_app' | 'json_otro' | 'vacio' | 'no_leido' | 'render' | 'html' | 'texto'
  if (/error code:?\s*1015|error 1015|"error_code"\s*:\s*1015/.test(muestra)) clase = 'cloudflare_1015'
  else if (json !== undefined) clase = esErrorDeLaApp(json) ? 'json_app' : 'json_otro'
  else if (!bytes) clase = aTiempo ? 'vacio' : 'no_leido'
  else if (mencionaRender) clase = 'render'
  else if (/^\s*<(?:!doctype|html)/.test(muestra)) clase = 'html'
  else clase = 'texto'
  return { clase, bytes, truncado: !completa, menciona_cloudflare: muestra.includes('cloudflare'), menciona_render: mencionaRender }
}

// Textos fijos con los que ForUsGuide responde 200 cuando el modelo devolvió
// contenido vacío o JSON inválido (rag_engine.ask_knowledge_question). No llevan
// ninguna marca en metadata, así que se reconocen por el texto exacto.
const FALLOS_DEL_MODELO = new Set([
  'Unable to generate a response. Please try again or contact Support.',
  'Unable to generate a structured answer.',
])

const SIN_EVIDENCIA = "I couldn't find relevant information in the knowledge base to answer this question."

// Los fallos de Pinecone en ForUsGuide siempre llevan un failure_kind conocido;
// "unknown" procede de excepciones ajenas a Pinecone, en la práctica el proveedor
// de IA que descompone la pregunta o redacta la respuesta.
function errorPorFallo(kind: unknown): KdError {
  if (kind === 'circuit_open' || kind === 'transport') return new KdError('VECTOR_DB_UNAVAILABLE', undefined, { origen: 'forusguide', failure_kind: kind })
  if (kind === 'timeout' || kind === 'rate_limit' || kind === 'server_error' || kind === 'client_error') {
    return new KdError('RETRIEVAL_ERROR', undefined, { origen: 'forusguide', failure_kind: kind })
  }
  return new KdError('AI_PROVIDER_ERROR', undefined, { origen: 'forusguide', failure_kind: 'unknown', inferido: true })
}

function errorPorEstado(status: number): KdError {
  if (status === 401 || status === 403) return new KdError('UPSTREAM_AUTH_ERROR', undefined, { upstream_status: status })
  if (status === 422) return new KdError('VALIDATION_ERROR', 'El servicio de consulta rechazó la pregunta.', { upstream_status: status })
  if (status === 503) return new KdError('VECTOR_DB_UNAVAILABLE', undefined, { upstream_status: status })
  return new KdError('UPSTREAM_ERROR', undefined, { upstream_status: status })
}

function texto(valor: unknown): string { return typeof valor === 'string' ? valor : '' }
function lista(valor: unknown): unknown[] { return Array.isArray(valor) ? valor : [] }
function numero(valor: unknown): number | null { return typeof valor === 'number' && Number.isFinite(valor) ? valor : null }

export function crearMotorForUsGuide(config: ForUsGuideConfig, fetchImpl: FetchImpl = fetch, opciones: OpcionesForUsGuide = {}): Motor {
  const ahora = opciones.ahora ?? Date.now
  const esperar = opciones.esperar ?? ((ms: number, signal: AbortSignal) => dormir(ms, undefined, { signal }))
  // Instante hasta el que ForUsGuide pidió no volver a llamarlo, y si ya hay un
  // reintento de recuperación en curso: solo se admite uno a la vez.
  let pausaHasta = 0
  let reintentando = false

  function cabeceras(requestId: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-correlation-id': requestId,
      // La credencial solo existe en el servidor; el navegador nunca la ve.
      ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
    }
  }

  async function enviar(ruta: string, cuerpo: unknown, requestId: string, signal: AbortSignal): Promise<Response> {
    try {
      return await fetchImpl(`${config.url}${ruta}`, { method: 'POST', headers: cabeceras(requestId), body: JSON.stringify(cuerpo), signal })
    } catch {
      if (signal.aborted) throw new KdError('TIMEOUT', undefined, { origen: 'forusguide' })
      throw new KdError('UPSTREAM_UNREACHABLE', undefined, { origen: 'forusguide' })
    }
  }

  // Amplía la pausa con la espera del 429.
  function pausar(respuesta: Response) {
    const segundos = segundosRetryAfter(respuesta.headers.get('retry-after'), ahora()) ?? ESPERA_SIN_INDICACION_S
    pausaHasta = Math.max(pausaHasta, ahora() + Math.max(1, segundos) * 1000)
  }

  const segundosEnPausa = () => Math.ceil((pausaHasta - ahora()) / 1000)

  // Un 429 pausa las llamadas en cuanto llegan sus cabeceras; después se
  // clasifica su cuerpo, lo que lo libera. Si la consulta venció mientras tanto,
  // es TIMEOUT, y la pausa ya registrada sigue vigente.
  async function intentar(ruta: string, cuerpo: unknown, requestId: string, signal: AbortSignal, intentos: Record<string, unknown>[]) {
    const inicio = performance.now()
    const respuesta = await enviar(ruta, cuerpo, requestId, signal)
    if (respuesta.status !== 429) return respuesta
    pausar(respuesta)
    const intento: Record<string, unknown> = { estado: 429, ms: Math.round(performance.now() - inicio), cabeceras: cabecerasDeOrigen(respuesta, config.apiKey) }
    intentos.push(intento)
    intento.cuerpo = await clasificarCuerpo(respuesta, signal)
    if (signal.aborted) {
      const error = new KdError('TIMEOUT', undefined, { origen: 'forusguide' })
      error.diagnostico = { intentos }
      throw error
    }
    return respuesta
  }

  async function llamar(ruta: string, cuerpo: unknown, requestId: string, signal: AbortSignal): Promise<Response> {
    if (segundosEnPausa() > 0) throw errorPorLimite(segundosEnPausa(), { pausa_local: true })
    const intentos: Record<string, unknown>[] = []
    const primera = await intentar(ruta, cuerpo, requestId, signal, intentos)
    if (primera.status !== 429) return primera
    const pausaPropia = pausaHasta
    // Si otra consulta ya está reintentando, o la espera es larga, se informa la espera.
    if (reintentando || pausaPropia - ahora() > MAX_ESPERA_REINTENTO_S * 1000) throw errorPorLimite(segundosEnPausa(), { intentos })
    reintentando = true
    try {
      try {
        await esperar(pausaPropia - ahora(), signal)
      } catch {
        throw new KdError('TIMEOUT', undefined, { origen: 'forusguide' })
      }
      // Otra respuesta amplió entretanto la pausa: se respeta mientras siga vigente.
      if (pausaHasta > pausaPropia && segundosEnPausa() > 0) throw errorPorLimite(segundosEnPausa(), { intentos })
      const segunda = await intentar(ruta, cuerpo, requestId, signal, intentos)
      if (segunda.status !== 429) return segunda
      throw errorPorLimite(segundosEnPausa(), { intentos })
    } finally {
      reintentando = false
    }
  }

  async function leerJson(respuesta: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
    try {
      const cuerpo = await respuesta.json() as unknown
      if (typeof cuerpo === 'object' && cuerpo !== null) return cuerpo as Record<string, unknown>
    } catch {
      if (signal.aborted) throw new KdError('TIMEOUT', undefined, { origen: 'forusguide' })
    }
    throw new KdError('UPSTREAM_ERROR', 'El servicio de consulta devolvió una respuesta con un formato inesperado.')
  }

  return {
    nombre: 'forusguide',

    async preguntar(pregunta: string, { requestId, signal }: ContextoConsulta): Promise<ResultadoMotor> {
      // Solo se envía la pregunta: nunca ticket_id ni contexto de otras consultas.
      const respuesta = await llamar('/api/v1/knowledge-question', { question: pregunta }, requestId, signal)
      if (!respuesta.ok) throw errorPorEstado(respuesta.status)
      const cuerpo = await leerJson(respuesta, signal)
      if (typeof cuerpo.answer !== 'string' || !Array.isArray(cuerpo.key_points)) {
        throw new KdError('UPSTREAM_ERROR', 'El servicio de consulta devolvió una respuesta con un formato inesperado.')
      }
      const metadata = (typeof cuerpo.metadata === 'object' && cuerpo.metadata !== null ? cuerpo.metadata : {}) as Record<string, unknown>
      if (typeof metadata.error === 'string' && metadata.error) throw errorPorFallo(metadata.retrieval_failure_kind)
      if (FALLOS_DEL_MODELO.has(cuerpo.answer.trim())) throw new KdError('AI_PROVIDER_ERROR', undefined, { origen: 'forusguide', inferido: true })

      const evidencia: Evidencia[] = lista(cuerpo.used_chunks).flatMap(item => {
        const chunk = item as Record<string, unknown>
        const id = texto(chunk.chunk_id)
        const score = numero(chunk.score)
        if (!id || score === null) return []
        return [{
          chunkId: id,
          articleId: texto(chunk.article_id),
          articleTitle: texto(chunk.article_title) || 'Artículo sin título',
          score,
          chunkType: texto(chunk.chunk_type) || 'unknown',
          content: texto(chunk.content) || texto(chunk.content_preview),
          paths: [],
        }]
      })
      const sinEvidencia = cuerpo.answer.trim() === SIN_EVIDENCIA
      return {
        motor: 'forusguide',
        respuesta: sinEvidencia ? '' : cuerpo.answer,
        puntosClave: lista(cuerpo.key_points).filter((punto): punto is string => typeof punto === 'string'),
        evidencia: sinEvidencia ? [] : evidencia,
        nivelMotor: texto(cuerpo.confidence_note) || null,
        vaciosCobertura: lista(metadata.coverage_gaps).filter((vacio): vacio is string => typeof vacio === 'string'),
        contradicciones: [],
        modelo: texto(metadata.model) || null,
        subconsultas: lista(metadata.sub_queries).filter((sub): sub is string => typeof sub === 'string'),
        fragmentosRecuperados: numero(metadata.chunks_used) ?? evidencia.length,
        articulosConsultados: numero(metadata.unique_articles) ?? lista(cuerpo.source_articles).length,
        generada: !sinEvidencia,
      }
    },

    // Artículo completo de la base de ForUsGuide, reconstruido con todos sus
    // fragmentos por el endpoint /api/v1/chunks (list + fetch, sin búsqueda).
    async articulo(articleId: string, { requestId, signal }: ContextoConsulta): Promise<ArticuloCompleto> {
      const respuesta = await llamar('/api/v1/chunks', { article_id: articleId, limit: 1000 }, requestId, signal)
      if (!respuesta.ok) throw errorPorEstado(respuesta.status)
      const cuerpo = await leerJson(respuesta, signal)
      const fragmentos = lista(cuerpo.chunks).flatMap(item => {
        const chunk = item as { id?: unknown; metadata?: Record<string, unknown> }
        const meta = chunk.metadata ?? {}
        if (texto(meta.article_id) !== articleId) return []
        return [{ id: texto(chunk.id), indice: numero(meta.chunk_index), tipo: texto(meta.chunk_type), contenido: texto(meta.content), titulo: texto(meta.article_title) }]
      })
      if (!fragmentos.length) throw new KdError('SOURCE_NOT_AVAILABLE', 'ForUsGuide no devolvió el contenido de ese artículo.')
      fragmentos.sort((a, b) => (a.indice ?? 0) - (b.indice ?? 0))
      return { articleId, titulo: fragmentos[0].titulo || articleId, fragmentos: fragmentos.map(({ titulo: _titulo, ...resto }) => resto) }
    },
  }
}
