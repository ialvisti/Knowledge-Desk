// Lo que un motor devuelve, sea ForUsGuide o el modo local. El servicio de
// consulta aplica después las mismas reglas de cobertura, fuentes y disponibilidad
// documental a ambos, así la interfaz recibe un contrato único.
export interface Evidencia {
  chunkId: string
  articleId: string
  articleTitle: string
  score: number
  chunkType: string
  content: string
  // Rutas JSON del artículo de las que sale el fragmento (vacío si el motor no las da).
  paths: string[]
}

export interface Contradiccion { descripcion: string; articleIds: string[] }

export interface ResultadoMotor {
  motor: 'forusguide' | 'local'
  respuesta: string
  puntosClave: string[]
  // Fragmentos que entraron en el contexto de la respuesta.
  evidencia: Evidencia[]
  // Nivel que calcula el propio motor, si lo hace (ForUsGuide). null = lo
  // calcula la política de Knowledge Desk.
  nivelMotor: string | null
  vaciosCobertura: string[]
  contradicciones: Contradiccion[]
  modelo: string | null
  subconsultas: string[]
  fragmentosRecuperados: number
  articulosConsultados: number
  // false cuando no se llamó al modelo porque no había evidencia.
  generada: boolean
  // true cuando el modelo respondió sin citar el contexto o declinó responder:
  // la respuesta no se presenta como sustentada.
  sinSustento?: boolean
  motivoSinSustento?: string
}

export interface ContextoConsulta { requestId: string; signal: AbortSignal }

export interface ArticuloCompleto {
  articleId: string
  titulo: string
  fragmentos: { id: string; indice: number | null; tipo: string; contenido: string }[]
}

export interface Motor {
  readonly nombre: 'forusguide' | 'local'
  preguntar(pregunta: string, contexto: ContextoConsulta): Promise<ResultadoMotor>
  articulo?(articleId: string, contexto: ContextoConsulta): Promise<ArticuloCompleto>
}
