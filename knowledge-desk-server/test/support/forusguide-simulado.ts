import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { PineconeSimulado } from './pinecone-simulado.ts'
import { similitud } from './similitud.ts'

// Simulador del backend de ForUsGuide con el contrato de
// POST /api/v1/knowledge-question y POST /api/v1/chunks tal como está en
// kb-rag-system (copia de trabajo): exige X-API-Key, responde errores como
// {error, message, request_id} y atrapa sus fallos internos devolviendo 200 con
// metadata.error. Recupera del Pinecone simulado, igual que el real lee el
// índice compartido, SIN conocer el estado de los documentos de Knowledge Desk.
export type FalloForUsGuide = null | 'retrieval' | 'vector' | 'proveedor' | 'llm_vacio' | 'no_inicializado' | 'error500'

export interface ForUsGuideSimulado {
  url: string
  apiKey: string | null
  control: { fallo: FalloForUsGuide; retrasoMs: number }
  recibidas: { ruta: string; cabeceras: Record<string, string | string[] | undefined>; cuerpo: unknown }[]
  cerrar(): Promise<void>
}

async function leer(request: IncomingMessage): Promise<string> {
  const partes: Buffer[] = []
  for await (const parte of request) partes.push(parte as Buffer)
  return Buffer.concat(partes).toString('utf8')
}

// Primera oración con contenido: se saltan los encabezados que añade el chunker
// ("# Step-by-Step Procedure", "## Step 1: …" conserva su texto) y las marcas.
function primeraOracion(texto: string) {
  const limpio = texto
    .split('\n')
    // Fuera el título del fragmento y los encabezados de categoría ("## Plazos:").
    .filter(linea => !/^#\s/.test(linea.trim()) && !/^#{2,6}\s[^.]*:$/.test(linea.trim()))
    .map(linea => linea.replace(/^#{2,6}\s+(Step \d+:\s*|Q:\s*|Issue:\s*)?/, '').replace(/\*\*[^*]+:\*\*\s*/g, '').replace(/^\s*-\s+/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (limpio.match(/[^.!?]+[.!?]/)?.[0] ?? limpio.slice(0, 160)).trim()
}

export async function iniciarForUsGuideSimulado(opciones: { pinecone: PineconeSimulado; apiKey: string | null; puerto?: number }): Promise<ForUsGuideSimulado> {
  const estado = {
    apiKey: opciones.apiKey,
    control: { fallo: null as FalloForUsGuide, retrasoMs: 0 },
    recibidas: [] as ForUsGuideSimulado['recibidas'],
  }
  const server: Server = createServer(async (request, response) => {
    const responder = (status: number, datos: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(datos))
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const texto = await leer(request)
    if (url.pathname === '/__control') {
      Object.assign(estado.control, JSON.parse(texto || '{}'))
      return responder(200, estado.control)
    }
    const cuerpo = texto ? JSON.parse(texto) as Record<string, unknown> : {}
    estado.recibidas.push({ ruta: url.pathname, cabeceras: request.headers, cuerpo })
    const requestId = 'fg-simulado'
    if (estado.apiKey) {
      const clave = request.headers['x-api-key']
      if (!clave) return responder(401, { error: 'http_error', message: "API key missing. Include 'X-API-Key' header.", request_id: requestId })
      if (clave !== estado.apiKey) return responder(403, { error: 'http_error', message: 'Invalid API key', request_id: requestId })
    }
    if (estado.control.retrasoMs) await new Promise(resolve => setTimeout(resolve, estado.control.retrasoMs))
    const visibles = [...opciones.pinecone.registros.values()].filter(registro => registro.visibleDesde <= Date.now())

    if (request.method === 'POST' && url.pathname === '/api/v1/chunks') {
      const articulo = String(cuerpo.article_id ?? '')
      const chunks = visibles.filter(registro => registro.article_id === articulo).map(({ _id, visibleDesde: _v, ...campos }) => ({ id: _id, score: 1, metadata: campos }))
      return responder(200, { chunks, total: chunks.length, filters_applied: { article_id: articulo } })
    }
    if (request.method !== 'POST' || url.pathname !== '/api/v1/knowledge-question') return responder(404, { error: 'http_error', message: 'Not Found', request_id: requestId })

    const pregunta = typeof cuerpo.question === 'string' ? cuerpo.question.trim() : ''
    if (pregunta.length < 10 || pregunta.length > 2000) return responder(422, { detail: [{ msg: 'String should have at least 10 characters' }] })
    const fallo = estado.control.fallo
    if (fallo === 'no_inicializado') return responder(503, { error: 'http_error', message: 'RAG Engine not initialized', request_id: requestId })
    if (fallo === 'error500') return responder(500, { error: 'http_error', message: 'An error occurred while processing the knowledge question.', request_id: requestId })
    const falloInterno = { retrieval: 'timeout', vector: 'circuit_open', proveedor: 'unknown' }[fallo as string]
    if (falloInterno) {
      return responder(200, {
        answer: 'An internal error occurred while processing your question.', key_points: [], source_articles: [], used_chunks: [],
        confidence_note: 'limited_coverage',
        metadata: { error: 'knowledge_question_failed', retrieval_failure_kind: falloInterno, retrieval_retryable: falloInterno !== 'unknown', chunks_used: 0, model: null, provider: null },
      })
    }
    if (fallo === 'llm_vacio') {
      return responder(200, { answer: 'Unable to generate a response. Please try again or contact Support.', key_points: [], source_articles: [], used_chunks: [], confidence_note: 'limited_coverage', metadata: { chunks_used: 0, model: null } })
    }

    const usados = visibles
      .map(registro => ({ registro, score: similitud(pregunta, registro.content) }))
      .filter(item => item.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
    if (!usados.length) {
      return responder(200, {
        answer: "I couldn't find relevant information in the knowledge base to answer this question.",
        key_points: [], source_articles: [], used_chunks: [], confidence_note: 'limited_coverage',
        metadata: { chunks_used: 0, model: null, provider: null, sub_queries: [pregunta] },
      })
    }
    const media = usados.slice(0, 5).reduce((total, item) => total + item.score, 0) / Math.min(5, usados.length)
    const nota = media >= 0.35 && usados.length >= 2 ? 'well_covered' : media >= 0.22 ? 'partially_covered' : 'limited_coverage'
    const articulos = new Map<string, { titulo: string; score: number; tipos: Set<string> }>()
    for (const { registro, score } of usados) {
      const id = String(registro.article_id)
      const previo = articulos.get(id) ?? { titulo: String(registro.article_title), score: 0, tipos: new Set<string>() }
      previo.score = Math.max(previo.score, score)
      previo.tipos.add(String(registro.chunk_type))
      articulos.set(id, previo)
    }
    // El chunker repite las reglas de elegibilidad en dos fragmentos: la
    // respuesta simulada no repite la misma frase.
    const frases = [...new Set(usados.map(item => primeraOracion(item.registro.content)))].slice(0, 3)
    return responder(200, {
      answer: `Según la documentación recuperada:\n\n${frases.map(frase => `- ${frase}`).join('\n')}`,
      key_points: frases,
      source_articles: [...articulos].map(([id, info]) => ({ article_id: id, article_title: info.titulo, chunk_types_used: [...info.tipos].join(', '), relevance: 'simulado', used_info: info.score >= 0.2, max_score: Number(info.score.toFixed(4)) })),
      used_chunks: usados.map(({ registro, score }) => ({
        chunk_id: registro._id, score: Number(score.toFixed(4)), chunk_type: registro.chunk_type, chunk_tier: registro.chunk_tier,
        article_id: registro.article_id, article_title: registro.article_title, content_preview: registro.content.slice(0, 200), content: registro.content,
      })),
      confidence_note: nota,
      // El simulador no usa ningún modelo: lo declara en vez de imitar uno real.
      metadata: { chunks_used: usados.length, unique_articles: articulos.size, model: 'simulado', provider: 'simulado', sub_queries: [pregunta], coverage_gaps: [] },
    })
  })
  await new Promise<void>(resolve => server.listen(opciones.puerto ?? 0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    get apiKey() { return estado.apiKey },
    control: estado.control,
    recibidas: estado.recibidas,
    url: `http://127.0.0.1:${port}`,
    cerrar: () => new Promise(resolve => server.close(() => resolve())),
  }
}
