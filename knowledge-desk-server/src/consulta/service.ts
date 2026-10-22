import { performance } from 'node:perf_hooks'
import type { Registro } from '../documents/store.ts'
import { KdError } from '../errors.ts'
import { esArticuloKd } from '../ids.ts'
import { evaluarCobertura, type Umbrales } from './coverage.ts'
import type { Evidencia, Motor } from './motor.ts'
import { validarPregunta } from './validate.ts'

// Bloques internos de los artículos de ForUsGuide (guías de decisión, datos
// requeridos…). Sustentan la respuesta, pero no son texto para quien consulta.
const OPERATIVOS = new Set(['critical_flags', 'decision_guide', 'guardrails', 'response_frames'])
const esOperativo = (tipo: string) => OPERATIVOS.has(tipo) || tipo.startsWith('required_data')

export interface Fuente {
  id: string
  kind: 'document' | 'external_article'
  title: string
  file_name: string | null
  article_id: string | null
  href: string
  document_id: string | null
  version: string | null
  location: string | null
  affinity: number
  fragment_count: number
  fragments: { id: string; affinity: number; type: string; paths: string[]; operational: boolean; content: string }[]
}

export interface DepsConsulta {
  motor: Motor | null
  registro: Registro
  umbrales: Umbrales
  timeoutMs: number
  // Se llama cuando la evidencia trae versiones no servibles (residuos en el
  // índice compartido): conviene limpiarlas cuanto antes.
  alDetectarNoServibles?: () => void
}

function exigirServibles(deps: DepsConsulta, evidencia: Evidencia[]) {
  const noServibles = evidencia.filter(item => esArticuloKd(item.articleId) && !deps.registro.articuloServible(item.articleId))
  if (!noServibles.length) return
  deps.alDetectarNoServibles?.()
  const documentos = [...new Set(noServibles.map(item => deps.registro.ubicarArticulo(item.articleId)?.documento.id ?? 'desconocido'))]
  throw new KdError('CONTENT_UNAVAILABLE', undefined, { documentos })
}

const redondear = (valor: number) => Math.round(valor * 100) / 100

// Rutas JSON de un fragmento de Knowledge Desk, leídas de los fragmentos
// guardados de su versión. ForUsGuide no las devuelve en used_chunks.
async function rutasDe(registro: Registro, evidencia: Evidencia): Promise<string[]> {
  if (evidencia.paths.length || !esArticuloKd(evidencia.articleId)) return evidencia.paths
  const ubicado = registro.ubicarArticulo(evidencia.articleId)
  const indice = Number(evidencia.chunkId.slice(evidencia.chunkId.lastIndexOf('_') + 1))
  if (!ubicado || !Number.isInteger(indice)) return []
  const fragmentos = await registro.leerFragmentos(ubicado.documento.id, ubicado.version.version)
  return fragmentos.find(fragmento => fragmento.indice === indice)?.rutas ?? []
}

// "details.steps[0]", "details.steps[1]", "details.steps[2]" → "details.steps[0–2]".
export function resumirRutas(rutas: string[]): string | null {
  if (!rutas.length) return null
  const indices = rutas.map(ruta => ruta.match(/^(.*)\[(\d+)\]$/))
  const base = indices[0]?.[1]
  if (base && indices.every(item => item && item[1] === base)) {
    const numeros = indices.map(item => Number(item![2]))
    return numeros.length === 1 ? rutas[0] : `${base}[${Math.min(...numeros)}–${Math.max(...numeros)}]`
  }
  return rutas.length > 2 ? `${rutas.slice(0, 2).join(', ')}…` : rutas.join(', ')
}

// Cada fuente sale de fragmentos que entraron en el contexto y superan el
// umbral de relevancia (HU04). No se listan artículos recuperados y descartados.
export async function construirFuentes(relevantes: Evidencia[], registro: Registro): Promise<Fuente[]> {
  const grupos = new Map<string, Evidencia[]>()
  for (const item of relevantes) grupos.set(item.articleId, [...(grupos.get(item.articleId) ?? []), item])
  const fuentes: Fuente[] = []
  for (const [articleId, items] of grupos) {
    items.sort((a, b) => b.score - a.score)
    const fragments = await Promise.all(items.map(async item => ({
      id: item.chunkId,
      affinity: redondear(item.score),
      type: item.chunkType,
      paths: await rutasDe(registro, item),
      operational: esOperativo(item.chunkType),
      content: item.content,
    })))
    const ubicado = esArticuloKd(articleId) ? registro.ubicarArticulo(articleId) : null
    fuentes.push({
      id: articleId,
      kind: ubicado ? 'document' : 'external_article',
      title: ubicado ? ubicado.version.articulo.titulo : items[0].articleTitle,
      file_name: ubicado ? ubicado.version.archivo.nombre : null,
      article_id: ubicado ? ubicado.version.articulo.id : articleId,
      // La versión exacta que sustentó la respuesta: si luego se reemplaza, el
      // enlace sigue abriendo el JSON de esa versión y avisa de que ya no está vigente.
      href: ubicado ? `/documentos/${ubicado.documento.id}?version=${ubicado.version.version}` : `/fuentes/${encodeURIComponent(articleId)}`,
      document_id: ubicado?.documento.id ?? null,
      version: ubicado?.version.version ?? null,
      location: resumirRutas(fragments[0].paths),
      affinity: redondear(items[0].score),
      fragment_count: items.length,
      fragments,
    })
  }
  return fuentes.sort((a, b) => b.affinity - a.affinity)
}

export async function consultar(deps: DepsConsulta, cuerpo: unknown, requestId: string) {
  // HU10: la validación ocurre antes de tocar cualquier servicio.
  const pregunta = validarPregunta(cuerpo)
  if (!deps.motor) throw new KdError('INTEGRATION_NOT_CONFIGURED')
  const inicio = performance.now()
  const signal = AbortSignal.timeout(deps.timeoutMs)
  const resultado = await deps.motor.preguntar(pregunta, { requestId, signal })

  // Solo la versión activa de un documento Indexado puede sustentar respuestas.
  // En modo forusguide la recuperación ocurre fuera, así que se comprueba aquí:
  // si el contexto usó un documento en proceso, bloqueado o retirado, la
  // respuesta ya está contaminada y no se presenta.
  exigirServibles(deps, resultado.evidencia)

  // Un fragmento cuenta una vez, y también un mismo texto del mismo artículo
  // (el chunker repite las reglas de elegibilidad en dos fragmentos).
  const unicos = new Map<string, Evidencia>()
  for (const item of resultado.evidencia) {
    const clave = item.content ? `${item.articleId}\u0000${item.content}` : item.chunkId
    const previo = unicos.get(clave)
    if (!previo || previo.score < item.score) unicos.set(clave, item)
  }
  const evidencia = [...unicos.values()].sort((a, b) => b.score - a.score)
  let cobertura = evaluarCobertura(evidencia, resultado.nivelMotor, resultado.vaciosCobertura, deps.umbrales)
  if (resultado.sinSustento && cobertura.sufficient) {
    cobertura = {
      ...cobertura,
      level: 'baja',
      label: 'Cobertura baja',
      explanation: `La respuesta generada no se presenta como sustentada: ${resultado.motivoSinSustento ?? 'no se apoyó en citas de las fuentes recuperadas'}.`,
      sufficient: false,
      basis: 'politica',
    }
  }
  if (cobertura.sufficient && !resultado.respuesta.trim()) {
    throw new KdError('AI_PROVIDER_ERROR', 'El modelo no devolvió texto para esta consulta. Inténtalo de nuevo.')
  }

  const relevantes = evidencia.filter(item => item.score >= deps.umbrales.minScore)
  const fuentes = await construirFuentes(relevantes, deps.registro)

  // Comprobación final, después del ÚLTIMO await: un documento retirado o
  // reemplazado mientras se preparaba la respuesta no puede salir como fuente.
  // Desde aquí hasta el return no hay más esperas, así que la revisión que se
  // devuelve es exactamente la que se comprobó.
  exigirServibles(deps, evidencia)
  const revision = deps.registro.revision
  const suficiente = cobertura.sufficient
  return {
    status: 'ok' as const,
    request_id: requestId,
    question: pregunta,
    outcome: suficiente ? 'answered' as const : 'insufficient' as const,
    answer: suficiente ? resultado.respuesta : null,
    key_points: suficiente ? resultado.puntosClave : [],
    coverage: cobertura,
    sources: suficiente ? fuentes : [],
    // Con evidencia insuficiente se informa qué se encontró, sin presentarlo
    // como sustento de ninguna respuesta.
    found_documents: suficiente ? [] : fuentes,
    contradictions: suficiente
      ? resultado.contradicciones.map(item => ({ description: item.descripcion, source_ids: item.articleIds }))
      : [],
    retrieval: {
      fragments_retrieved: resultado.fragmentosRecuperados,
      articles_consulted: resultado.articulosConsultados,
      model: resultado.modelo,
      sub_queries: resultado.subconsultas,
      generated: resultado.generada,
    },
    engine: deps.motor.nombre,
    elapsed_ms: Math.round(performance.now() - inicio),
    corpus_revision: revision,
  }
}

export type ContratoConsulta = Awaited<ReturnType<typeof consultar>>
