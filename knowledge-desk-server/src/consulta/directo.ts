import { redactarConEvidencia, errorProveedor, type OpcionesContexto } from './local.ts'
import type { Umbrales } from './coverage.ts'
import type { ArticuloCompleto, ContextoConsulta, Motor, ResultadoMotor } from './motor.ts'
import { KdError } from '../errors.ts'
import { IndiceError, type BuscadorCorpus, type Coincidencia } from '../index/types.ts'
import type { Proveedor } from '../providers/openaiCompatible.ts'

// Parámetros de ask_knowledge_question en ForUsGuide (rag_engine.py): 15
// fragmentos por búsqueda, 6 por artículo, un presupuesto de 4000 tokens
// (~16000 caracteres) y estos tipos primero.
export const TOP_K_POR_CONSULTA = 15
export const CONTEXTO_DIRECTO: OpcionesContexto = {
  presupuestoCaracteres: 16_000,
  maxPorDocumento: 6,
  priorizarTipos: ['business_rules', 'eligibility', 'steps', 'faqs', 'guardrails', 'fees_details'],
}
const MAX_SUBCONSULTAS = 3

// Adaptación del prompt de descomposición de ForUsGuide
// (SYSTEM_PROMPT_DECOMPOSE_QUESTION) sin los ejemplos propios de su dominio.
export const PROMPT_DESCOMPOSICION = `You are a query decomposition assistant for a knowledge base search system.
Your task: break the question into 1-3 focused search queries, each targeting a DISTINCT topic, rule or process.
Rules:
1. Each sub-query targets a DIFFERENT concept, threshold, rule or process.
2. Keep procedural details: amounts, ages, time periods and account types.
3. Never include company, employer, person or plan proper names: the knowledge base only stores general procedures.
4. Sub-queries are 10-25 words, specific enough for semantic search, in the language of the knowledge base (English).
5. If the question covers ONE topic, return exactly 1 sub-query. Never return more than 3.
Output valid JSON: {"sub_queries": ["query 1"]}`

// Como en ForUsGuide, un fallo de la descomposición no detiene la consulta: se
// busca con la pregunta original. Una cancelación sí la detiene.
async function descomponerConModelo(proveedor: Proveedor, pregunta: string, signal: AbortSignal): Promise<string[]> {
  try {
    const salida = await proveedor.chatJson([
      { role: 'system', content: PROMPT_DESCOMPOSICION },
      { role: 'user', content: `QUESTION:\n${pregunta}\n\nBreak this into focused search sub-queries. Return ONLY the JSON object.` },
    ], signal) as { sub_queries?: unknown }
    const lista = Array.isArray(salida?.sub_queries) ? salida.sub_queries : []
    return lista.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim().slice(0, 300)).slice(0, MAX_SUBCONSULTAS)
  } catch (error) {
    if (signal.aborted) throw errorProveedor(error, 'AI_PROVIDER_ERROR', signal)
    return []
  }
}

function errorBusqueda(error: unknown, signal: AbortSignal): KdError {
  if (signal.aborted || (error instanceof IndiceError && error.tipo === 'cancelado')) return new KdError('TIMEOUT', undefined, { origen: 'pinecone' })
  return new KdError('VECTOR_DB_UNAVAILABLE', undefined, { origen: 'pinecone', tipo: error instanceof IndiceError ? error.tipo : 'desconocido' })
}

// Modo directo: el endpoint knowledge-question de ForUsGuide sin ForUsGuide.
// Recupera del índice Pinecone compartido con búsqueda de texto (Pinecone
// calcula los embeddings con su modelo integrado) y redacta con el proveedor
// configurado. Las reglas de contexto, cobertura y citas son las de Knowledge Desk.
export function crearMotorDirecto(deps: { proveedor: Proveedor; buscador: BuscadorCorpus; umbrales: Umbrales }): Motor {
  return {
    nombre: 'directo',

    async preguntar(pregunta: string, { signal }: ContextoConsulta): Promise<ResultadoMotor> {
      // 1. Subconsultas del modelo; la pregunta original siempre se busca también.
      const subconsultas = (await descomponerConModelo(deps.proveedor, pregunta, signal)).filter(item => item !== pregunta)

      // 2. Búsquedas de texto en paralelo, sin filtro, como knowledge-question.
      let resultados: Coincidencia[][]
      try {
        resultados = await Promise.all([pregunta, ...subconsultas].map(texto => deps.buscador.buscar(texto, TOP_K_POR_CONSULTA, { signal })))
      } catch (error) {
        throw errorBusqueda(error, signal)
      }

      return redactarConEvidencia({ proveedor: deps.proveedor, umbrales: deps.umbrales, motor: 'directo', contexto: CONTEXTO_DIRECTO }, pregunta, subconsultas, resultados, signal)
    },

    async articulo(articleId: string, { signal }: ContextoConsulta): Promise<ArticuloCompleto> {
      let hits: Coincidencia[]
      try {
        hits = await deps.buscador.fragmentosArticulo(articleId, signal)
      } catch (error) {
        throw errorBusqueda(error, signal)
      }
      if (!hits.length) throw new KdError('SOURCE_NOT_AVAILABLE')
      const indice = (hit: Coincidencia) => (typeof hit.metadata.chunk_index === 'number' ? hit.metadata.chunk_index : null)
      const fragmentos = hits
        .map(hit => ({ id: hit.id, indice: indice(hit), tipo: String(hit.metadata.chunk_type ?? 'unknown'), contenido: String(hit.metadata.content ?? '') }))
        .sort((a, b) => (a.indice ?? Number.MAX_SAFE_INTEGER) - (b.indice ?? Number.MAX_SAFE_INTEGER))
      return { articleId, titulo: String(hits[0].metadata.article_title ?? articleId), fragmentos }
    },
  }
}
