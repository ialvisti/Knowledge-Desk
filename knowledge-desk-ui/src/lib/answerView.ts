import type { KnowledgeAnswer, SourceArticle, UsedChunk } from '../api/knowledgeQuestion'

export interface AnswerFragment {
  id: string
  score: number
  content: string
}

export interface AnswerSource {
  id: string
  title: string
  used: boolean
  score: number | null
  fragments: AnswerFragment[]
}

export interface CoverageLabel {
  label: string
  icon: string
  modifier: string
}

const COVERAGE: Record<string, CoverageLabel> = {
  well_covered: { label: 'Cobertura alta', icon: 'verified', modifier: 'coverage-high' },
  partially_covered: { label: 'Cobertura parcial', icon: 'info', modifier: 'coverage-partial' },
  limited_coverage: { label: 'Cobertura limitada', icon: 'warning', modifier: 'coverage-limited' },
}

export function coverageLabel(note: string): CoverageLabel {
  // Object.hasOwn evita que un valor como "constructor" caiga en el prototipo.
  return Object.hasOwn(COVERAGE, note)
    ? COVERAGE[note]
    : { label: 'Cobertura sin determinar', icon: 'help', modifier: 'coverage-partial' }
}

function articleKey(article: SourceArticle, index: number) {
  return article.article_id ?? `articulo-${index}`
}

// Un artículo del índice mezcla conocimiento consultable con bloques operativos
// que sólo consumen los procesos internos. La consulta muestra el conocimiento y
// deja fuera esos bloques, que no aportan nada a quien pregunta.
// Los nombres son los que emite el troceador del backend. required_data se parte
// en cuatro variantes (must_have, nice_to_have, if_missing, disambiguation), así
// que ese prefijo se cubre entero.
const HIDDEN_CHUNK_TYPES = new Set([
  'critical_flags',
  'decision_guide',
  'guardrails',
  'response_frames',
])
const HIDDEN_CHUNK_PREFIX = 'required_data'

export function isPresentable(chunk: UsedChunk): boolean {
  const type = chunk.chunk_type
  return !HIDDEN_CHUNK_TYPES.has(type) && !type.startsWith(HIDDEN_CHUNK_PREFIX)
}

// Los fragmentos llegan aparte de los artículos: se agrupan por artículo para
// que cada ficha muestre el texto exacto que alimentó la respuesta.
function fragmentsOf(chunks: UsedChunk[], articleId: string | null, title: string): AnswerFragment[] {
  return chunks
    .filter(isPresentable)
    .filter(chunk => (articleId ? chunk.article_id === articleId : chunk.article_title === title))
    .sort((first, second) => second.score - first.score)
    .map(chunk => ({ id: chunk.chunk_id, score: chunk.score, content: chunk.content || chunk.content_preview }))
}

export function buildSources(answer: KnowledgeAnswer): AnswerSource[] {
  return answer.source_articles
    .map((article, index) => {
      const title = article.article_title?.trim() || 'Artículo sin título'
      return {
        id: articleKey(article, index),
        title,
        used: article.used_info,
        score: typeof article.max_score === 'number' ? article.max_score : null,
        fragments: fragmentsOf(answer.used_chunks, article.article_id, title),
      }
    })
    .sort((first, second) => Number(second.used) - Number(first.used) || (second.score ?? 0) - (first.score ?? 0))
}

export function formatScore(score: number | null): string | null {
  return score === null ? null : score.toFixed(2)
}

export interface RetrievalSummary {
  chunks: number | null
  articles: number | null
  model: string | null
  subQueries: string[]
}

export function retrievalSummary(answer: KnowledgeAnswer): RetrievalSummary {
  const metadata = answer.metadata
  const readNumber = (field: string) => {
    const value = metadata[field]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  const model = metadata.model
  const subQueries = metadata.sub_queries
  return {
    chunks: readNumber('chunks_used') ?? (answer.used_chunks.length || null),
    articles: readNumber('unique_articles') ?? (answer.source_articles.length || null),
    model: typeof model === 'string' && model ? model : null,
    subQueries: Array.isArray(subQueries)
      ? [...new Set(subQueries.filter((item): item is string => typeof item === 'string'))]
      : [],
  }
}
