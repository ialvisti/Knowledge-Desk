export type ValorMetadato = string | number | boolean | string[]

export interface RegistroIndice {
  id: string
  texto: string
  metadata: Record<string, ValorMetadato>
}

export interface Coincidencia {
  id: string
  score: number
  metadata: Record<string, unknown>
}

// Un error del índice nunca lleva el cuerpo de la respuesta externa: solo una
// clase estable para decidir si se reintenta o cómo se informa.
export class IndiceError extends Error {
  readonly tipo: 'no_disponible' | 'solicitud' | 'embeddings' | 'cancelado'
  constructor(tipo: IndiceError['tipo'], mensaje: string) {
    super(mensaje)
    this.name = 'IndiceError'
    this.tipo = tipo
  }
}

export interface OpcionesBusqueda {
  signal?: AbortSignal
  // article_id que no pueden ocupar el topK (versiones en proceso, fallidas,
  // reemplazadas o retiradas). Se excluyen ANTES del corte, no después.
  excluirArticulos?: string[]
}

export interface IndiceCorpus {
  readonly tipo: 'pinecone' | 'local'
  readonly descripcion: string
  upsert(registros: RegistroIndice[], signal?: AbortSignal): Promise<void>
  listarIds(prefijo: string, signal?: AbortSignal): Promise<string[]>
  eliminar(ids: string[], signal?: AbortSignal): Promise<void>
  buscar(texto: string, topK: number, opciones?: OpcionesBusqueda): Promise<Coincidencia[]>
  // true cuando el artículo ya aparece en búsquedas. Listar un ID no garantiza
  // que la búsqueda lo encuentre: Pinecone es eventualmente consistente.
  esBuscable(articleId: string, textoMuestra: string, signal?: AbortSignal): Promise<boolean>
}
