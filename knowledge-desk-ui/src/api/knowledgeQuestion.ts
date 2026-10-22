// Cliente del endpoint POST /api/v1/knowledge-question del backend RAG.
// El contrato replica los modelos KnowledgeQuestionRequest/Response de la API.

export const MIN_QUESTION_LENGTH = 10
export const MAX_QUESTION_LENGTH = 2000

export type ConfidenceNote = 'well_covered' | 'partially_covered' | 'limited_coverage'

export interface SourceArticle {
  article_id: string | null
  article_title: string | null
  chunk_types_used: string | null
  relevance: string | null
  used_info: boolean
  max_score: number | null
}

export interface UsedChunk {
  chunk_id: string
  score: number
  chunk_type: string
  chunk_tier: string
  article_id: string
  article_title: string
  content_preview: string
  content: string
}

export interface KnowledgeAnswer {
  answer: string
  key_points: string[]
  source_articles: SourceArticle[]
  used_chunks: UsedChunk[]
  confidence_note: string
  metadata: Record<string, unknown>
}

export type FailureKind = 'validation' | 'timeout' | 'network' | 'unavailable' | 'server'

export class KnowledgeQuestionError extends Error {
  readonly kind: FailureKind
  readonly status: number | null
  constructor(kind: FailureKind, message: string, status: number | null = null) {
    super(message)
    this.name = 'KnowledgeQuestionError'
    this.kind = kind
    this.status = status
  }
}

// Sin VITE_API_BASE_URL las peticiones salen relativas y las reescribe el proxy
// de Vite hacia el backend local, así que el navegador nunca cruza de origen.
const rawBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''
const baseUrl = rawBase.replace(/\/+$/, '')
export const endpoint = `${baseUrl}/api/v1/knowledge-question`

const rawTimeout = Number(import.meta.env.VITE_API_TIMEOUT_MS as string | undefined)
// Una respuesta real recupera fragmentos y sintetiza con el modelo: 15 s es lo
// habitual y una pregunta amplia puede acercarse al minuto.
export const requestTimeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 120_000

export function validateQuestion(question: string): string | null {
  const value = question.trim()
  if (!value) return 'Escribe una pregunta para comenzar.'
  // El backend mide puntos de código, no unidades UTF-16: Array.from cuenta igual.
  const length = Array.from(value).length
  if (length < MIN_QUESTION_LENGTH) return `La pregunta necesita al menos ${MIN_QUESTION_LENGTH} caracteres.`
  if (length > MAX_QUESTION_LENGTH) return `La pregunta supera los ${MAX_QUESTION_LENGTH} caracteres.`
  return null
}

function isAnswer(value: unknown): value is KnowledgeAnswer {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<KnowledgeAnswer>
  return typeof candidate.answer === 'string' && Array.isArray(candidate.key_points)
}

async function readDetail(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return null
    const detail = (body as { detail?: unknown }).detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) {
      const messages = detail
        .map(item => (typeof item === 'object' && item !== null ? (item as { msg?: unknown }).msg : null))
        .filter((msg): msg is string => typeof msg === 'string')
      return messages.length ? messages.join(' ') : null
    }
    return null
  } catch {
    return null
  }
}

async function request(question: string): Promise<KnowledgeAnswer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
  const aborted = () => new KnowledgeQuestionError('timeout', 'La consulta tardó demasiado. Vuelve a intentarlo.')
  try {
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      })
    } catch {
      if (controller.signal.aborted) throw aborted()
      throw new KnowledgeQuestionError('network', 'No hay conexión con la API. Comprueba que el backend esté en marcha.')
    }

    if (!response.ok) {
      const detail = await readDetail(response)
      if (response.status === 422) {
        throw new KnowledgeQuestionError('validation', detail ?? 'La API rechazó la pregunta.', 422)
      }
      if (response.status === 503) {
        throw new KnowledgeQuestionError('unavailable', 'El servicio de conocimiento no está disponible ahora mismo.', 503)
      }
      throw new KnowledgeQuestionError('server', detail ?? `La API respondió con un error ${response.status}.`, response.status)
    }

    const payload: unknown = await response.json().catch(() => null)
    if (payload === null && controller.signal.aborted) throw aborted()
    if (!isAnswer(payload)) {
      throw new KnowledgeQuestionError('server', 'La API devolvió una respuesta con un formato inesperado.', response.status)
    }
    const metadata = typeof payload.metadata === 'object' && payload.metadata !== null ? payload.metadata : {}
    // El backend atrapa sus propios fallos y responde 200 con un texto de aviso
    // y metadata.error. Sin esto la pantalla lo presentaría como una respuesta.
    const failure = (metadata as { error?: unknown }).error
    if (typeof failure === 'string' && failure) {
      throw new KnowledgeQuestionError('server', 'El backend no pudo completar la consulta. Vuelve a intentarlo.', response.status)
    }
    return {
      answer: payload.answer,
      key_points: Array.isArray(payload.key_points) ? payload.key_points : [],
      source_articles: Array.isArray(payload.source_articles) ? payload.source_articles : [],
      used_chunks: Array.isArray(payload.used_chunks) ? payload.used_chunks : [],
      confidence_note: typeof payload.confidence_note === 'string' ? payload.confidence_note : '',
      metadata: metadata as Record<string, unknown>,
    }
  } finally {
    clearTimeout(timer)
  }
}

// Una pregunta sólo se envía una vez a la vez. El montaje doble de StrictMode y
// la vuelta atrás del navegador reutilizan la petición o el resultado en curso
// en lugar de gastar otra síntesis del modelo.
const MAX_CACHED = 20
const answers = new Map<string, KnowledgeAnswer>()
const pending = new Map<string, Promise<KnowledgeAnswer>>()

export function askKnowledgeQuestion(question: string): Promise<KnowledgeAnswer> {
  const key = question.trim()
  const cached = answers.get(key)
  if (cached) return Promise.resolve(cached)
  const running = pending.get(key)
  if (running) return running
  const promise = request(key)
    .then(answer => {
      if (answers.size >= MAX_CACHED) {
        const oldest = answers.keys().next().value
        if (oldest !== undefined) answers.delete(oldest)
      }
      answers.set(key, answer)
      return answer
    })
    .finally(() => { pending.delete(key) })
  pending.set(key, promise)
  return promise
}

export function forgetAnswer(question: string) {
  answers.delete(question.trim())
}
