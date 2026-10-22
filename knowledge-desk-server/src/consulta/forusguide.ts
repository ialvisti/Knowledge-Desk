import type { ForUsGuideConfig } from '../config.ts'
import { KdError } from '../errors.ts'
import type { ArticuloCompleto, ContextoConsulta, Evidencia, Motor, ResultadoMotor } from './motor.ts'

type FetchImpl = typeof fetch

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

export function crearMotorForUsGuide(config: ForUsGuideConfig, fetchImpl: FetchImpl = fetch): Motor {
  function cabeceras(requestId: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-correlation-id': requestId,
      // La credencial solo existe en el servidor; el navegador nunca la ve.
      ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
    }
  }

  async function llamar(ruta: string, cuerpo: unknown, requestId: string, signal: AbortSignal): Promise<Response> {
    try {
      return await fetchImpl(`${config.url}${ruta}`, { method: 'POST', headers: cabeceras(requestId), body: JSON.stringify(cuerpo), signal })
    } catch {
      if (signal.aborted) throw new KdError('TIMEOUT', undefined, { origen: 'forusguide' })
      throw new KdError('UPSTREAM_UNREACHABLE', undefined, { origen: 'forusguide' })
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
