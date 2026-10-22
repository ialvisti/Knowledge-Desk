import type { ErrorContrato } from './tipos'

// Errores que solo puede detectar el navegador: la petición no llegó o no
// volvió a tiempo. El resto llega del servidor con el contrato de HU10.
export const ERROR_RED = 'NETWORK_ERROR'
export const ERROR_TIEMPO_CLIENTE = 'CLIENT_TIMEOUT'

export class ApiError extends Error {
  readonly code: string
  readonly status: number | null
  readonly requestId: string | null
  readonly retryable: boolean
  readonly contrato: ErrorContrato | null

  constructor(code: string, message: string, opciones: { status?: number | null; requestId?: string | null; retryable?: boolean; contrato?: ErrorContrato | null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = opciones.status ?? null
    this.requestId = opciones.requestId ?? null
    this.retryable = opciones.retryable ?? true
    this.contrato = opciones.contrato ?? null
  }
}

// El navegador propone el identificador de correlación: así el "ID de soporte"
// que ve la persona es el mismo que registra el servidor, incluso si la
// respuesta no llega a tiempo.
export function nuevoRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  return `req-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
}

function esContratoError(valor: unknown): valor is ErrorContrato {
  return typeof valor === 'object' && valor !== null && (valor as ErrorContrato).status === 'error' && typeof (valor as ErrorContrato).code === 'string'
}

// El JSON original de una versión, byte a byte, con el SHA-256 que declara el
// servidor. Se lee como bytes para poder verificarlo en el navegador.
export interface Original { bytes: Uint8Array; texto: string; sha256: string | null }

export async function leerOriginal(ruta: string, signal?: AbortSignal): Promise<Original> {
  const requestId = nuevoRequestId()
  if (signal?.aborted) throw new ApiError('ABORTED', 'Solicitud cancelada.', { requestId, retryable: false })
  let respuesta: Response
  try {
    respuesta = await fetch(ruta, { headers: { 'x-request-id': requestId }, signal })
  } catch {
    if (signal?.aborted) throw new ApiError('ABORTED', 'Solicitud cancelada.', { requestId, retryable: false })
    throw new ApiError(ERROR_RED, 'No hay conexión con el servidor de Knowledge Desk.', { requestId })
  }
  if (!respuesta.ok) {
    const cuerpo: unknown = await respuesta.json().catch(() => null)
    if (esContratoError(cuerpo)) throw new ApiError(cuerpo.code, cuerpo.message, { status: respuesta.status, requestId: cuerpo.request_id ?? requestId, contrato: cuerpo })
    throw new ApiError(`HTTP_${respuesta.status}`, `El servidor respondió con un error ${respuesta.status}.`, { status: respuesta.status, requestId })
  }
  const bytes = new Uint8Array(await respuesta.arrayBuffer())
  return { bytes, texto: new TextDecoder('utf-8').decode(bytes), sha256: respuesta.headers.get('x-content-sha256') }
}

export interface OpcionesPeticion {
  method?: 'GET' | 'POST'
  json?: unknown
  formData?: FormData
  requestId?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export async function pedir<T>(ruta: string, opciones: OpcionesPeticion = {}): Promise<T> {
  const requestId = opciones.requestId ?? nuevoRequestId()
  // Una señal ya cancelada no envía nada: ni siquiera llega al servidor.
  if (opciones.signal?.aborted) throw new ApiError('ABORTED', 'Solicitud cancelada.', { requestId, retryable: false })
  const controlador = new AbortController()
  let agotado = false
  const temporizador = opciones.timeoutMs ? setTimeout(() => { agotado = true; controlador.abort() }, opciones.timeoutMs) : null
  const cancelarExterno = () => controlador.abort()
  opciones.signal?.addEventListener('abort', cancelarExterno)
  try {
    let respuesta: Response
    try {
      respuesta = await fetch(ruta, {
        method: opciones.method ?? (opciones.json !== undefined || opciones.formData ? 'POST' : 'GET'),
        headers: { 'x-request-id': requestId, ...(opciones.json !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: opciones.formData ?? (opciones.json !== undefined ? JSON.stringify(opciones.json) : undefined),
        signal: controlador.signal,
      })
    } catch {
      if (agotado) throw new ApiError(ERROR_TIEMPO_CLIENTE, 'La consulta superó el tiempo máximo de espera. Inténtalo de nuevo o simplifica la pregunta.', { requestId })
      if (opciones.signal?.aborted) throw new ApiError('ABORTED', 'Solicitud cancelada.', { requestId, retryable: false })
      throw new ApiError(ERROR_RED, 'No hay conexión con el servidor de Knowledge Desk. Comprueba tu conexión e inténtalo de nuevo.', { requestId })
    }
    let cuerpo: unknown = null
    try {
      cuerpo = await respuesta.json()
    } catch {
      if (agotado) throw new ApiError(ERROR_TIEMPO_CLIENTE, 'La consulta superó el tiempo máximo de espera. Inténtalo de nuevo o simplifica la pregunta.', { requestId })
    }
    if (!respuesta.ok) {
      if (esContratoError(cuerpo)) {
        throw new ApiError(cuerpo.code, cuerpo.message, {
          status: respuesta.status,
          requestId: cuerpo.request_id ?? requestId,
          retryable: cuerpo.details?.retryable !== false,
          contrato: cuerpo,
        })
      }
      throw new ApiError(`HTTP_${respuesta.status}`, `El servidor respondió con un error ${respuesta.status}.`, { status: respuesta.status, requestId })
    }
    if (cuerpo === null) throw new ApiError('INVALID_RESPONSE', 'El servidor devolvió una respuesta con un formato inesperado.', { requestId, status: respuesta.status })
    return cuerpo as T
  } finally {
    if (temporizador) clearTimeout(temporizador)
    opciones.signal?.removeEventListener('abort', cancelarExterno)
  }
}
