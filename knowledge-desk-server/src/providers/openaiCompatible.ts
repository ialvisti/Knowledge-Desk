import type { ProveedorConfig } from '../config.ts'

export class ProveedorError extends Error {
  readonly tipo: 'timeout' | 'red' | 'http' | 'formato' | 'configuracion'
  readonly status: number | null
  constructor(tipo: ProveedorError['tipo'], mensaje: string, status: number | null = null) {
    super(mensaje)
    this.name = 'ProveedorError'
    this.tipo = tipo
    this.status = status
  }
}

export interface MensajeChat { role: 'system' | 'user'; content: string }

export interface Proveedor {
  readonly modeloEmbeddings: string
  readonly modeloChat: string
  embeddings(textos: string[], signal?: AbortSignal): Promise<number[][]>
  chatJson(mensajes: MensajeChat[], signal?: AbortSignal): Promise<unknown>
}

type FetchImpl = typeof fetch

// Un embedding corrupto publicado en el índice contamina todas las búsquedas
// posteriores. Antes de aceptar un lote se exige: un vector por texto, índices
// únicos 0..N-1, solo números finitos y la misma dimensión en todo el corpus.
export function validarLote(datos: unknown, esperados: number, dimension: number | null): number[][] {
  if (!Array.isArray(datos) || datos.length !== esperados) throw new ProveedorError('formato', 'El proveedor no devolvió un embedding por texto')
  const porIndice: (number[] | undefined)[] = Array.from({ length: esperados })
  for (const item of datos as { index?: unknown; embedding?: unknown }[]) {
    const indice = item?.index
    if (typeof indice !== 'number' || !Number.isInteger(indice) || indice < 0 || indice >= esperados || porIndice[indice]) {
      throw new ProveedorError('formato', 'El proveedor devolvió índices de embeddings duplicados o fuera de rango')
    }
    const vector = item.embedding
    if (!Array.isArray(vector) || !vector.length || !vector.every(valor => typeof valor === 'number' && Number.isFinite(valor))) {
      throw new ProveedorError('formato', 'El proveedor devolvió un embedding con valores no numéricos')
    }
    const esperada = dimension ?? porIndice.find(Boolean)?.length ?? vector.length
    if (vector.length !== esperada) throw new ProveedorError('formato', 'El proveedor devolvió embeddings de dimensiones distintas')
    porIndice[indice] = vector as number[]
  }
  return porIndice as number[][]
}

// Cliente mínimo para cualquier servicio con la API de OpenAI (Ollama, LM Studio,
// vLLM, Azure OpenAI con compatibilidad, OpenAI). La clave, si existe, solo vive
// en este proceso.
export function crearProveedor(config: ProveedorConfig, fetchImpl: FetchImpl = fetch): Proveedor {
  async function post(ruta: string, cuerpo: unknown, signal?: AbortSignal): Promise<unknown> {
    let respuesta: Response
    try {
      respuesta = await fetchImpl(`${config.baseUrl}${ruta}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify(cuerpo),
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw new ProveedorError('timeout', 'El proveedor no respondió a tiempo')
      throw new ProveedorError('red', `No hay conexión con el proveedor (${(error as Error).name})`)
    }
    if (!respuesta.ok) throw new ProveedorError('http', `El proveedor respondió ${respuesta.status}`, respuesta.status)
    try {
      return await respuesta.json()
    } catch {
      throw new ProveedorError('formato', 'El proveedor devolvió un cuerpo que no es JSON')
    }
  }

  return {
    modeloEmbeddings: config.embeddingModel,
    modeloChat: config.chatModel,

    async embeddings(textos, signal) {
      if (!config.embeddingModel) throw new ProveedorError('configuracion', 'Falta KD_EMBEDDINGS_MODEL')
      const vectores: number[][] = []
      let dimension: number | null = null
      for (let inicio = 0; inicio < textos.length; inicio += 32) {
        if (signal?.aborted) throw new ProveedorError('timeout', 'Se canceló la generación de embeddings')
        const lote = textos.slice(inicio, inicio + 32)
        const cuerpo = await post('/embeddings', { model: config.embeddingModel, input: lote }, signal) as { data?: unknown }
        vectores.push(...validarLote(cuerpo.data, lote.length, dimension))
        dimension = vectores[0].length
      }
      return vectores
    },

    async chatJson(mensajes, signal) {
      if (!config.chatModel) throw new ProveedorError('configuracion', 'Falta KD_CHAT_MODEL')
      const cuerpo = await post('/chat/completions', {
        model: config.chatModel,
        messages: mensajes,
        temperature: 0,
        response_format: { type: 'json_object' },
      }, signal) as { choices?: { message?: { content?: unknown } }[] }
      const contenido = cuerpo.choices?.[0]?.message?.content
      if (typeof contenido !== 'string' || !contenido.trim()) throw new ProveedorError('formato', 'El modelo no devolvió contenido')
      try {
        return JSON.parse(contenido) as unknown
      } catch {
        throw new ProveedorError('formato', 'El modelo no devolvió JSON válido')
      }
    },
  }
}
