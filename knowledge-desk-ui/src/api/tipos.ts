// Contratos que entrega el servidor de Knowledge Desk. La consulta sigue el
// contrato único de HU10; documentos y operaciones son la API de administración.

export type NivelCobertura = 'alta' | 'parcial' | 'baja' | 'sin_evidencia'

export interface Cobertura {
  level: NivelCobertura
  label: string
  explanation: string
  sufficient: boolean
  relevant_fragments: number
  total_fragments: number
  documents: number
  policy: string
  basis: 'motor' | 'politica'
}

export interface FragmentoFuente {
  id: string
  affinity: number
  type: string
  // Rutas JSON del artículo de las que sale el fragmento (p. ej. details.steps[0]).
  paths: string[]
  operational: boolean
  content: string
}

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
  fragments: FragmentoFuente[]
}

export interface ContratoConsulta {
  status: 'ok'
  request_id: string
  question: string
  outcome: 'answered' | 'insufficient'
  answer: string | null
  key_points: string[]
  coverage: Cobertura
  sources: Fuente[]
  found_documents: Fuente[]
  contradictions: { description: string; source_ids: string[] }[]
  retrieval: { fragments_retrieved: number; articles_consulted: number; model: string | null; sub_queries: string[]; generated: boolean }
  engine: 'forusguide' | 'local'
  elapsed_ms: number
  corpus_revision: number
}

export interface ErrorContrato {
  status: 'error'
  code: string
  message: string
  details: Record<string, unknown> | null
  request_id: string | null
}

export interface EstadoServidor {
  modo: 'forusguide' | 'local' | 'sin_configurar'
  consulta: { configurada: boolean; motor: string | null }
  indexacion: { configurada: boolean; destino: string | null }
  faltan: string[]
  limites: { preguntaMin: number; preguntaMax: number; archivoMaxBytes: number; formatos: string[]; esquema: string }
  // Solo el stack de demostración: servicios externos simulados.
  simulado: boolean
  // Vista previa con almacenamiento efímero (KD_DATOS_TEMPORALES).
  datosTemporales: boolean
  consultaTimeoutMs: number
  cobertura: { politica: string; umbralRelevancia: number }
  usuario: string
  puedeAdministrar: boolean
  accesoControlado: boolean
  // Vista previa abierta, sin inicio de sesión (KD_ACCESO_PUBLICO).
  accesoPublico: boolean
  contactoUrl: string | null
  revisionCorpus: number
  residuosPendientes: number
}

export interface Ejemplos {
  examples: string[]
  verified: boolean
  note: string | null
}

export type EstadoDocumento = 'procesando' | 'indexado' | 'error' | 'eliminando' | 'bloqueado' | 'retirado'

export interface DocumentoResumen {
  id: string
  nombre: string
  estado: EstadoDocumento
  fechaCarga: string
  fragmentos: number | null
  versionActiva: string | null
  tipo: 'json'
  bytes: number
  // Identidad canónica del artículo (metadata.article_id y metadata.title).
  articuloId: string
  titulo: string
  error: { etapa: string; mensaje: string } | null
  operacionEnCurso: { id: string; tipo: TipoOperacion; version: string | null } | null
  creadoEn: string
}

export type TipoOperacion = 'carga' | 'reemplazo' | 'reintento' | 'eliminacion'

export interface Operacion {
  id: string
  tipo: TipoOperacion
  documentoId: string
  documentoNombre: string
  version: string | null
  versionAnterior: string | null
  operador: string
  inicio: string
  fin: string | null
  resultado: 'en_curso' | 'exitoso' | 'fallido' | 'fallido_parcial'
  mensaje: string | null
  contadores: {
    fragmentos?: { hechos: number; total: number }
    embeddings?: { hechos: number; total: number }
    registro?: 'retirado' | 'pendiente' | 'activo'
  }
  pasos: { nombre: string; estado: 'ok' | 'error' | 'omitido'; detalle: string; en: string }[]
}

export interface DetalleDocumento {
  documento: DocumentoResumen
  version: {
    version: string
    estado: 'procesando' | 'activa' | 'fallida' | 'reemplazada' | 'retirada'
    nombre: string
    tipo: 'json'
    bytes: number
    sha256: string
    cargadoEn: string
    fragmentos: number
    articulo: IdentidadArticulo
    error: { etapa: string; mensaje: string } | null
    archivoUrl: string | null
  }
  fragmentos: FragmentoIndexado[]
  versiones: { version: string; estado: string; nombre: string; cargadoEn: string; fragmentos: number }[]
  operaciones: { id: string; tipo: TipoOperacion; resultado: Operacion['resultado']; inicio: string; fin: string | null; version: string | null }[]
}

export interface IdentidadArticulo {
  id: string
  titulo: string
  recordKeeper: string | null
  planType: string | null
  schemaVersion: string | null
  avisos: string[]
}

export interface FragmentoIndexado {
  indice: number
  texto: string
  tipo: string
  categoria: string
  nivel: 'critical' | 'high' | 'medium' | 'low'
  rutas: string[]
  parte: [number, number] | null
}

// Artículo del corpus de ForUsGuide: ForUsGuide no expone su JSON original,
// solo los fragmentos indexados, y el servidor lo declara en "origen".
export interface ArticuloExterno {
  tipo: 'articulo_externo'
  origen: 'fragmentos_indexados'
  articleId: string
  titulo: string
  fragmentos: { id: string; indice: number | null; tipo: string; contenido: string }[]
}
