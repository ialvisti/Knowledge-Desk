// Contrato de error único (HU10): {status, code, message, details, request_id}.
// Los mensajes se escriben para quien usa la interfaz. Nunca incluyen cuerpos de
// servicios externos, claves ni rutas internas.
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'RETRIEVAL_ERROR'
  | 'VECTOR_DB_UNAVAILABLE'
  | 'AI_PROVIDER_ERROR'
  | 'TIMEOUT'
  | 'UPSTREAM_UNREACHABLE'
  | 'UPSTREAM_AUTH_ERROR'
  | 'UPSTREAM_ERROR'
  | 'INTEGRATION_NOT_CONFIGURED'
  | 'CONTENT_UNAVAILABLE'
  | 'INDEX_NOT_CONFIGURED'
  | 'UNSUPPORTED_FORMAT'
  | 'INVALID_ARTICLE'
  | 'DUPLICATE_ARTICLE'
  | 'ARTICLE_MISMATCH'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'FILE_REQUIRED'
  | 'DUPLICATE_DOCUMENT'
  | 'DOCUMENT_BUSY'
  | 'INVALID_STATE'
  | 'CONFIRMATION_REQUIRED'
  | 'NOT_FOUND'
  | 'SOURCE_NOT_AVAILABLE'
  | 'ACCESS_DENIED'
  | 'OPERATOR_REQUIRED'
  | 'INTERNAL_ERROR'

interface Definicion { status: number; message: string; retryable: boolean }

const CATALOGO: Record<ErrorCode, Definicion> = {
  VALIDATION_ERROR: { status: 422, retryable: false, message: 'La pregunta no es válida: no puede estar vacía ni superar el largo permitido.' },
  RETRIEVAL_ERROR: { status: 502, retryable: true, message: 'Ocurrió un problema al recuperar la información. Inténtalo de nuevo en unos minutos.' },
  VECTOR_DB_UNAVAILABLE: { status: 503, retryable: true, message: 'El servicio de búsqueda no responde en este momento. Inténtalo de nuevo más tarde.' },
  AI_PROVIDER_ERROR: { status: 502, retryable: true, message: 'El servicio que redacta las respuestas falló. Inténtalo de nuevo en unos minutos.' },
  TIMEOUT: { status: 504, retryable: true, message: 'La consulta superó el tiempo máximo de espera. Inténtalo de nuevo o simplifica la pregunta.' },
  UPSTREAM_UNREACHABLE: { status: 503, retryable: true, message: 'El servicio de consulta no responde. Inténtalo de nuevo más tarde.' },
  UPSTREAM_AUTH_ERROR: { status: 502, retryable: false, message: 'El servicio de consulta rechazó la credencial del servidor. Avisa al administrador.' },
  UPSTREAM_ERROR: { status: 502, retryable: true, message: 'El servicio de consulta no pudo completar la solicitud. Inténtalo de nuevo en unos minutos.' },
  INTEGRATION_NOT_CONFIGURED: { status: 503, retryable: false, message: 'El servidor no tiene configurado un motor de consulta. Revisa la configuración de Knowledge Desk.' },
  CONTENT_UNAVAILABLE: { status: 409, retryable: true, message: 'La respuesta se apoyaba en un documento que está en proceso, bloqueado o retirado, así que no se presenta. Inténtalo de nuevo cuando termine la operación.' },
  INDEX_NOT_CONFIGURED: { status: 503, retryable: false, message: 'No es posible indexar documentos: la integración con el índice no está configurada.' },
  UNSUPPORTED_FORMAT: { status: 415, retryable: false, message: 'Formato no admitido. Carga un artículo de conocimiento en JSON (.json).' },
  INVALID_ARTICLE: { status: 422, retryable: false, message: 'El archivo no es un artículo de conocimiento kb_article_v2 válido.' },
  DUPLICATE_ARTICLE: { status: 409, retryable: false, message: 'Ese artículo ya existe en el corpus. Usa Editar para reemplazarlo.' },
  ARTICLE_MISMATCH: { status: 409, retryable: false, message: 'El nuevo archivo corresponde a otro artículo. Para un artículo distinto usa Cargar documento.' },
  EMPTY_FILE: { status: 400, retryable: false, message: 'El archivo está vacío.' },
  FILE_TOO_LARGE: { status: 413, retryable: false, message: 'El archivo supera el tamaño máximo permitido.' },
  FILE_REQUIRED: { status: 400, retryable: false, message: 'Selecciona un archivo para cargar.' },
  DUPLICATE_DOCUMENT: { status: 409, retryable: false, message: 'Ya existe un documento con ese nombre. Usa Editar para reemplazarlo.' },
  DOCUMENT_BUSY: { status: 409, retryable: true, message: 'El documento tiene otra operación en curso. Espera a que termine.' },
  INVALID_STATE: { status: 409, retryable: false, message: 'El documento no admite esta acción en su estado actual.' },
  CONFIRMATION_REQUIRED: { status: 400, retryable: false, message: 'Confirma la acción antes de continuar.' },
  NOT_FOUND: { status: 404, retryable: false, message: 'El recurso solicitado no existe.' },
  SOURCE_NOT_AVAILABLE: { status: 404, retryable: false, message: 'La fuente no está disponible para su visualización.' },
  ACCESS_DENIED: { status: 401, retryable: false, message: 'El acceso a Knowledge Desk está limitado al entorno interno.' },
  OPERATOR_REQUIRED: { status: 403, retryable: false, message: 'Solo un operador técnico autorizado puede administrar documentos.' },
  INTERNAL_ERROR: { status: 500, retryable: true, message: 'Ocurrió un error inesperado. Inténtalo de nuevo.' },
}

export class KdError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly retryable: boolean
  readonly details: Record<string, unknown>

  constructor(code: ErrorCode, message?: string, details: Record<string, unknown> = {}) {
    const definicion = CATALOGO[code]
    super(message ?? definicion.message)
    this.name = 'KdError'
    this.code = code
    this.status = definicion.status
    this.retryable = definicion.retryable
    this.details = details
  }
}

export function cuerpoError(error: KdError, requestId: string) {
  return {
    status: 'error' as const,
    code: error.code,
    message: error.message,
    details: { retryable: error.retryable, ...error.details },
    request_id: requestId,
  }
}
