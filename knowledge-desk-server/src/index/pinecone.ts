import { AsyncLocalStorage } from 'node:async_hooks'
import { Pinecone } from '@pinecone-database/pinecone'
import type { PineconeConfig } from '../config.ts'
import { IndiceError, type Coincidencia, type IndiceCorpus, type OpcionesBusqueda, type RegistroIndice } from './types.ts'

const LOTE_UPSERT = 96 // límite de Pinecone para registros de texto con embeddings integrados
const LOTE_DELETE = 1000

type FetchApi = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

function clasificar(error: unknown, accion: string, signal?: AbortSignal): IndiceError {
  if (signal?.aborted) return new IndiceError('cancelado', `Se canceló ${accion}`)
  const nombre = error instanceof Error ? error.name : 'Error'
  const solicitud = /BadRequest|NotFound|Authorization|Forbidden|Argument|Validation/i.test(nombre)
  return new IndiceError(solicitud ? 'solicitud' : 'no_disponible', `Pinecone rechazó ${accion} (${nombre})`)
}

// Índice compartido con ForUsGuide. Usa el mismo namespace y el mismo formato de
// registro que su pipeline (campo "content" embebido por Pinecone con
// llama-text-embed-v2 y metadatos planos), así lo que se indexa aquí es
// recuperable por el endpoint knowledge-question.
export function crearIndicePinecone(config: PineconeConfig, opciones: { fetchApi?: FetchApi; maxRetries?: number } = {}): IndiceCorpus {
  // El SDK no acepta una señal por operación. Cada llamada guarda la suya en un
  // contexto asíncrono y el fetch del SDK la usa, así cancelar corta de verdad
  // la petición HTTP en vuelo.
  const senales = new AsyncLocalStorage<AbortSignal | undefined>()
  const base: FetchApi = opciones.fetchApi ?? fetch
  const fetchConSenal: FetchApi = (input, init = {}) => {
    const senal = senales.getStore()
    const combinada = senal && init.signal ? AbortSignal.any([senal, init.signal]) : (senal ?? init.signal ?? undefined)
    return base(input, { ...init, signal: combinada })
  }
  const cliente = new Pinecone({
    apiKey: config.apiKey,
    maxRetries: opciones.maxRetries ?? 2,
    sourceTag: 'knowledge_desk',
    fetchApi: fetchConSenal as never,
  })
  const indice = cliente.index({ host: config.indexHost, namespace: config.namespace })

  async function ejecutar<T>(accion: string, signal: AbortSignal | undefined, operacion: () => Promise<T>): Promise<T> {
    if (signal?.aborted) throw new IndiceError('cancelado', `Se canceló ${accion} antes de iniciarla`)
    try {
      return await senales.run(signal, operacion)
    } catch (error) {
      throw clasificar(error, accion, signal)
    }
  }

  async function buscar(texto: string, topK: number, extra: OpcionesBusqueda & { soloArticulo?: string } = {}): Promise<Coincidencia[]> {
    const filtro = extra.soloArticulo
      ? { article_id: { $eq: extra.soloArticulo } }
      : extra.excluirArticulos?.length ? { article_id: { $nin: extra.excluirArticulos } } : undefined
    const respuesta = await ejecutar('la búsqueda', extra.signal, () => indice.searchRecords({
      query: { topK, inputs: { text: texto }, ...(filtro ? { filter: filtro } : {}) },
      fields: ['article_id', 'article_title', 'chunk_type', 'content', 'kd_json_paths'],
    }))
    return (respuesta.result?.hits ?? []).map(hit => ({
      id: hit._id,
      score: hit._score,
      metadata: (hit.fields ?? {}) as Record<string, unknown>,
    }))
  }

  return {
    tipo: 'pinecone',
    descripcion: `Pinecone · namespace ${config.namespace}`,

    async upsert(registros: RegistroIndice[], signal?: AbortSignal) {
      for (let inicio = 0; inicio < registros.length; inicio += LOTE_UPSERT) {
        const lote = registros.slice(inicio, inicio + LOTE_UPSERT).map(registro => ({ _id: registro.id, content: registro.texto, ...registro.metadata }))
        await ejecutar('el upsert de registros', signal, () => indice.upsertRecords({ records: lote }))
      }
    },

    async listarIds(prefijo: string, signal?: AbortSignal) {
      const ids: string[] = []
      let token: string | undefined
      do {
        const pagina = await ejecutar('el listado de registros', signal, () => indice.listPaginated({ prefix: prefijo, limit: 100, ...(token ? { paginationToken: token } : {}) }))
        for (const vector of pagina.vectors ?? []) if (vector.id) ids.push(vector.id)
        token = pagina.pagination?.next ?? undefined
      } while (token)
      return ids
    },

    async eliminar(ids: string[], signal?: AbortSignal) {
      for (let inicio = 0; inicio < ids.length; inicio += LOTE_DELETE) {
        const lote = ids.slice(inicio, inicio + LOTE_DELETE)
        await ejecutar('el borrado de registros', signal, () => indice.deleteMany({ ids: lote }))
      }
    },

    buscar: (texto, topK, extra) => buscar(texto, topK, extra),

    async esBuscable(articleId: string, textoMuestra: string, signal?: AbortSignal) {
      const hits = await buscar(textoMuestra, 1, { signal, soloArticulo: articleId })
      return hits.length > 0
    },
  }
}
