import { KdError } from '../errors.ts'

// Artículo de conocimiento kb_article_v2 (ForUsGuide). Los artículos son JSON
// puros: { metadata, details }. La validación sigue al procesador real de
// ForUsGuide (article_processor.py: metadata + details y metadata.article_id,
// title, record_keeper, plan_type) y comprueba el TIPO de las secciones que el
// chunker consume. No rechaza artículos reales por campos opcionales ausentes.

export type Json = null | boolean | number | string | Json[] | { [clave: string]: Json }
export type Objeto = { [clave: string]: Json }

export interface Articulo { metadata: Objeto; details: Objeto }

export interface ResumenArticulo {
  id: string
  titulo: string
  descripcion: string | null
  recordKeeper: string | null
  planType: string | null
  scope: string | null
  schemaVersion: string | null
  topic: string | null
  avisos: string[]
}

export class ArticuloInvalido extends KdError {
  constructor(ruta: string, motivo: string) {
    super('INVALID_ARTICLE', `${ruta}: ${motivo}`, { ruta })
  }
}

export const LONGITUD_MAXIMA = { article_id: 200, title: 500 } as const

const esObjeto = (valor: unknown): valor is Objeto => typeof valor === 'object' && valor !== null && !Array.isArray(valor)
const esTexto = (valor: unknown): valor is string => typeof valor === 'string'

function textoOpcional(objeto: Objeto, clave: string, ruta: string) {
  const valor = objeto[clave]
  if (valor !== undefined && valor !== null && !esTexto(valor)) throw new ArticuloInvalido(`${ruta}.${clave}`, 'debe ser texto o null')
}

function listaDeTextos(objeto: Objeto, clave: string, ruta: string) {
  const valor = objeto[clave]
  if (valor === undefined || valor === null) return
  if (!Array.isArray(valor) || !valor.every(esTexto)) throw new ArticuloInvalido(`${ruta}.${clave}`, 'debe ser una lista de textos')
}

function listaDeObjetos(objeto: Objeto, clave: string, ruta: string, validarItem?: (item: Objeto, rutaItem: string) => void) {
  const valor = objeto[clave]
  if (valor === undefined || valor === null) return
  if (!Array.isArray(valor)) throw new ArticuloInvalido(`${ruta}.${clave}`, 'debe ser una lista')
  valor.forEach((item, indice) => {
    const rutaItem = `${ruta}.${clave}[${indice}]`
    if (!esObjeto(item)) throw new ArticuloInvalido(rutaItem, 'debe ser un objeto')
    validarItem?.(item, rutaItem)
  })
}

function objetoOpcional(objeto: Objeto, clave: string, ruta: string): Objeto | null {
  const valor = objeto[clave]
  if (valor === undefined || valor === null) return null
  if (!esObjeto(valor)) throw new ArticuloInvalido(`${ruta}.${clave}`, 'debe ser un objeto')
  return valor
}

function camposTexto(item: Objeto, ruta: string, ...claves: string[]) {
  for (const clave of claves) textoOpcional(item, clave, ruta)
}

export function nombreSeguro(nombre: string): string {
  const base = nombre.split(/[\\/]/).pop() ?? 'articulo.json'
  // Los caracteres de control se eliminan a propósito: no caben en un nombre de archivo.
  // eslint-disable-next-line no-control-regex
  const limpio = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '').trim()
  return (limpio || 'articulo.json').slice(0, 180)
}

// Solo se aceptan artículos de conocimiento en JSON. El archivo original se
// guarda tal cual; lo que se indexa se deriva de él sin modificarlo.
export function validarArchivoArticulo(nombre: string, contenido: Buffer, maxBytes: number) {
  if (!nombre.toLowerCase().endsWith('.json')) throw new KdError('UNSUPPORTED_FORMAT', `${nombre}: formato no admitido. Carga un artículo de conocimiento en JSON (.json).`)
  if (contenido.length === 0) throw new KdError('EMPTY_FILE', `${nombre}: el archivo está vacío.`)
  if (contenido.length > maxBytes) throw new KdError('FILE_TOO_LARGE', `${nombre}: supera el límite de ${Math.round(maxBytes / 1024 / 1024)} MB.`)
  const datos = leerJson(nombre, contenido)
  try {
    return validarArticulo(datos)
  } catch (error) {
    if (error instanceof ArticuloInvalido) throw new KdError('INVALID_ARTICLE', `${nombre}: no es un artículo kb_article_v2 válido (${error.message}).`, error.details)
    throw error
  }
}

// Decodifica los bytes como UTF-8 estricto (RFC 8259) y analiza el JSON.
export function leerJson(nombre: string, contenido: Buffer): unknown {
  let texto: string
  try {
    texto = new TextDecoder('utf-8', { fatal: true }).decode(contenido)
  } catch {
    throw new KdError('INVALID_ARTICLE', `${nombre}: el archivo no está codificado en UTF-8.`, { ruta: '$' })
  }
  if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1)
  if (!texto.trim()) throw new KdError('EMPTY_FILE', `${nombre}: el archivo está vacío.`)
  try {
    return JSON.parse(texto) as unknown
  } catch (error) {
    throw new KdError('INVALID_ARTICLE', `${nombre}: no es JSON válido (${(error as Error).message}).`, { ruta: '$' })
  }
}

export function validarArticulo(valor: unknown): { articulo: Articulo; resumen: ResumenArticulo } {
  if (!esObjeto(valor)) throw new ArticuloInvalido('$', 'la raíz debe ser un objeto con "metadata" y "details"')
  const avisos: string[] = []
  const metadata = valor.metadata
  const details = valor.details
  if (!esObjeto(metadata)) throw new ArticuloInvalido('$.metadata', 'falta o no es un objeto')
  if (!esObjeto(details)) throw new ArticuloInvalido('$.details', 'falta o no es un objeto')
  for (const clave of Object.keys(valor)) {
    if (clave === 'summary') avisos.push('La sección "summary" es de una versión anterior del esquema; se conserva en el original y no se indexa.')
    else if (clave !== 'metadata' && clave !== 'details') avisos.push(`La clave raíz "${clave}" no pertenece a kb_article_v2; se conserva en el original y no se indexa.`)
  }

  // --- metadata (campos que exige el procesador real) ---
  for (const clave of ['article_id', 'title'] as const) {
    if (!esTexto(metadata[clave]) || !metadata[clave].trim()) throw new ArticuloInvalido(`metadata.${clave}`, 'es obligatorio y debe ser un texto no vacío')
    // Identifican el artículo en el índice, los metadatos y la interfaz.
    const maximo = LONGITUD_MAXIMA[clave]
    if (metadata[clave].length > maximo) throw new ArticuloInvalido(`metadata.${clave}`, `supera ${maximo} caracteres`)
  }
  for (const clave of ['record_keeper', 'plan_type'] as const) {
    if (!(clave in metadata)) throw new ArticuloInvalido(`metadata.${clave}`, 'es obligatorio (puede ser null)')
    textoOpcional(metadata, clave, 'metadata')
  }
  camposTexto(metadata, 'metadata', 'description', 'audience', 'scope', 'language', 'last_updated', 'schema_version', 'transformed_at', 'source_last_updated', 'source_system', 'topic')
  listaDeTextos(metadata, 'tags', 'metadata')
  listaDeTextos(metadata, 'subtopics', 'metadata')
  const articleId = metadata.article_id as string
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(articleId)) avisos.push('metadata.article_id no sigue lower_snake_case como pide la guía del esquema.')
  if (metadata.schema_version !== undefined && metadata.schema_version !== null && metadata.schema_version !== 'kb_article_v2') {
    avisos.push(`metadata.schema_version es "${String(metadata.schema_version)}" y no "kb_article_v2".`)
  }

  // --- details: tipos de las secciones que consume el chunker ---
  const flags = objetoOpcional(details, 'critical_flags', 'details')
  if (flags) {
    for (const clave of ['portal_required', 'mfa_relevant'] as const) {
      if (flags[clave] !== undefined && flags[clave] !== null && typeof flags[clave] !== 'boolean') throw new ArticuloInvalido(`details.critical_flags.${clave}`, 'debe ser booleano')
    }
    textoOpcional(flags, 'record_keeper_must_be', 'details.critical_flags')
  }
  listaDeObjetos(details, 'business_rules', 'details', (item, ruta) => {
    textoOpcional(item, 'category', ruta)
    listaDeTextos(item, 'rules', ruta)
  })
  listaDeObjetos(details, 'fees', 'details', (item, ruta) => camposTexto(item, ruta, 'service', 'fee', 'notes'))
  listaDeObjetos(details, 'steps', 'details', (item, ruta) => {
    if (item.step_number !== undefined && item.step_number !== null && typeof item.step_number !== 'number' && typeof item.step_number !== 'string') {
      throw new ArticuloInvalido(`${ruta}.step_number`, 'debe ser un número')
    }
    camposTexto(item, ruta, 'type', 'visibility', 'description', 'notes')
  })
  listaDeObjetos(details, 'common_issues', 'details', (item, ruta) => camposTexto(item, ruta, 'issue', 'resolution'))
  listaDeObjetos(details, 'examples', 'details', (item, ruta) => camposTexto(item, ruta, 'scenario', 'outcome'))
  const notas = details.additional_notes
  if (notas !== undefined && notas !== null) {
    if (!Array.isArray(notas)) throw new ArticuloInvalido('details.additional_notes', 'debe ser una lista')
    const todosTexto = notas.every(esTexto)
    if (!todosTexto) {
      notas.forEach((nota, indice) => {
        const ruta = `details.additional_notes[${indice}]`
        if (!esObjeto(nota)) throw new ArticuloInvalido(ruta, 'debe ser un objeto {category, notes} o la lista entera textos')
        textoOpcional(nota, 'category', ruta)
        listaDeTextos(nota, 'notes', ruta)
      })
    }
  }
  listaDeObjetos(details, 'faq_pairs', 'details', (item, ruta) => camposTexto(item, ruta, 'question', 'answer'))
  listaDeObjetos(details, 'definitions', 'details', (item, ruta) => camposTexto(item, ruta, 'term', 'definition'))
  const guardrails = objetoOpcional(details, 'guardrails', 'details')
  if (guardrails) {
    listaDeTextos(guardrails, 'must_not', 'details.guardrails')
    listaDeTextos(guardrails, 'must_do_if_unsure', 'details.guardrails')
  }
  const referencias = objetoOpcional(details, 'references', 'details')
  if (referencias) {
    textoOpcional(referencias, 'participant_portal', 'details.references')
    listaDeTextos(referencias, 'internal_articles', 'details.references')
    const enlaces = referencias.external_links
    if (enlaces !== undefined && enlaces !== null) {
      if (!Array.isArray(enlaces) || !enlaces.every(enlace => esTexto(enlace) || esObjeto(enlace))) {
        throw new ArticuloInvalido('details.references.external_links', 'debe ser una lista de textos o de objetos {label, url, purpose}')
      }
    }
    const contacto = objetoOpcional(referencias, 'contact', 'details.references')
    if (contacto) camposTexto(contacto, 'details.references.contact', 'email', 'phone', 'support_hours')
  }
  const requeridos = objetoOpcional(details, 'required_data', 'details')
  if (requeridos) {
    const campoDato = (item: Objeto, ruta: string) => camposTexto(item, ruta, 'data_point', 'meaning', 'why_needed', 'source_note', 'source_type', 'blocking_intent')
    listaDeObjetos(requeridos, 'must_have', 'details.required_data', campoDato)
    listaDeObjetos(requeridos, 'nice_to_have', 'details.required_data', campoDato)
    listaDeObjetos(requeridos, 'if_missing', 'details.required_data', (item, ruta) => camposTexto(item, ruta, 'missing_data_point', 'ask_participant', 'agent_note'))
    listaDeTextos(requeridos, 'disambiguation_notes', 'details.required_data')
  }
  const guia = objetoOpcional(details, 'decision_guide', 'details')
  if (guia) {
    for (const clave of ['supported_outcomes', 'eligibility_requirements', 'blocking_conditions', 'allowed_conclusions', 'not_allowed_conclusions']) listaDeTextos(guia, clave, 'details.decision_guide')
    listaDeObjetos(guia, 'missing_data_conditions', 'details.decision_guide')
  }
  const marcos = objetoOpcional(details, 'response_frames', 'details')
  if (marcos) {
    for (const [resultado, marco] of Object.entries(marcos)) {
      const ruta = `details.response_frames.${resultado}`
      if (marco === null) continue
      if (!esObjeto(marco)) throw new ArticuloInvalido(ruta, 'debe ser un objeto')
      for (const clave of ['participant_message_components', 'next_steps', 'warnings', 'questions_to_ask', 'what_not_to_say']) listaDeTextos(marco, clave, ruta)
    }
  }

  const texto = (clave: string) => (esTexto(metadata[clave]) ? metadata[clave] as string : null)
  return {
    articulo: { metadata, details },
    resumen: {
      id: articleId,
      titulo: (metadata.title as string).trim(),
      descripcion: texto('description'),
      recordKeeper: texto('record_keeper'),
      planType: texto('plan_type'),
      scope: texto('scope'),
      schemaVersion: texto('schema_version'),
      topic: texto('topic'),
      avisos,
    },
  }
}
