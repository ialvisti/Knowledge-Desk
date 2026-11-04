import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Unzip, UnzipInflate } from 'fflate'
import { KdError } from '../errors.ts'
import { partir, type Fragmento, type Nivel } from './chunker.ts'
import type { IdentidadArticulo } from './store.ts'

// Documentos de texto (HU07): PDF con texto, DOCX y TXT, además de los artículos
// JSON kb_article_v2. El archivo original se guarda tal cual; de él se extrae el
// texto, que se segmenta en bloques (títulos, párrafos, ítems de lista,
// preguntas), se clasifica y se agrupa en fragmentos. Nada se inventa: cada
// fragmento es texto literal del archivo con la ruta de los bloques de origen.

export type FormatoDocumento = 'json' | 'pdf' | 'docx' | 'txt'
export type FormatoTexto = Exclude<FormatoDocumento, 'json'>
export const FORMATOS_ADMITIDOS: readonly FormatoDocumento[] = ['json', 'pdf', 'docx', 'txt']
export const REGLA_TEXTO = 'kd-texto-bloques-v1'
export const REGLA_CLASIFICACION = 'kd-clasificacion-v1'

// Límites del texto extraído, independientes del tamaño del archivo: un PDF o un
// DOCX pequeño puede expandirse mucho. Acotan también los registros del índice.
export const MAX_TEXTO_CARACTERES = 1_000_000
export const MAX_XML_DOCX_BYTES = 20 * 1024 * 1024
export const MAX_PAGINAS_PDF = 500
const MAX_FRAGMENTO_TEXTO = 1500

const MENSAJE_FORMATOS = 'Formatos admitidos: artículo JSON (kb_article_v2), PDF con texto, DOCX y TXT en UTF-8.'

// Firmas de archivos frecuentes que NO se admiten. Se rechazan aunque la
// extensión diga otra cosa, antes de guardar nada o llamar a ningún servicio.
const FIRMAS_RECHAZADAS: { nombre: string; firma: number[] }[] = [
  { nombre: 'PNG', firma: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { nombre: 'JPEG', firma: [0xff, 0xd8, 0xff] },
  { nombre: 'GIF', firma: [0x47, 0x49, 0x46, 0x38] },
  { nombre: 'WebP/RIFF', firma: [0x52, 0x49, 0x46, 0x46] },
  { nombre: 'BMP', firma: [0x42, 0x4d] },
  { nombre: 'ejecutable', firma: [0x4d, 0x5a] },
]
const empiezaCon = (datos: Buffer, firma: number[]) => datos.length >= firma.length && firma.every((byte, posicion) => datos[posicion] === byte)

function extensionDe(nombre: string): string {
  const punto = nombre.lastIndexOf('.')
  return punto > 0 ? nombre.slice(punto + 1).toLowerCase() : ''
}

// Formato por extensión Y contenido. La extensión decide qué se intenta leer;
// la firma del contenido debe coincidir con ella.
export function detectarFormato(nombre: string, contenido: Buffer): FormatoDocumento {
  const extension = extensionDe(nombre)
  const rechazada = FIRMAS_RECHAZADAS.find(item => empiezaCon(contenido, item.firma))
  if (rechazada) throw new KdError('UNSUPPORTED_FORMAT', `${nombre}: el contenido es un archivo ${rechazada.nombre}, que no se admite. ${MENSAJE_FORMATOS}`)
  if (!(FORMATOS_ADMITIDOS as readonly string[]).includes(extension)) {
    throw new KdError('UNSUPPORTED_FORMAT', `${nombre}: formato no admitido${extension ? ` (.${extension})` : ''}. ${MENSAJE_FORMATOS}`)
  }
  return extension as FormatoDocumento
}

function invalido(nombre: string, motivo: string): KdError {
  return new KdError('INVALID_DOCUMENT', `${nombre}: ${motivo}`)
}

function decodificarUtf8(nombre: string, datos: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(datos)
  } catch {
    throw invalido(nombre, 'el texto no está codificado en UTF-8. Guárdalo como UTF-8 e inténtalo de nuevo.')
  }
}

function textoTxt(nombre: string, datos: Buffer): string {
  let texto = decodificarUtf8(nombre, datos)
  if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1)
  for (let indice = 0; indice < texto.length; indice++) {
    const codigo = texto.charCodeAt(indice)
    if (codigo < 9 || (codigo > 13 && codigo < 32)) throw invalido(nombre, 'el TXT contiene datos binarios. Carga un archivo de texto UTF-8.')
  }
  return texto
}

const requerir = createRequire(import.meta.url)
let pdfjs: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null
// Fuentes estándar de pdf.js: sin ellas avisa en cada página con texto en Helvetica/Times.
const FUENTES_PDF = `${pathToFileURL(path.join(path.dirname(requerir.resolve('pdfjs-dist/package.json')), 'standard_fonts')).href}/`

async function textoPdf(nombre: string, datos: Buffer): Promise<string> {
  if (!empiezaCon(datos, [0x25, 0x50, 0x44, 0x46, 0x2d])) throw invalido(nombre, 'no es un PDF: le falta la cabecera %PDF-.')
  pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs')
  const { getDocument, VerbosityLevel } = await pdfjs
  // Copia propia: pdf.js transfiere el buffer que recibe.
  const tarea = getDocument({ data: new Uint8Array(datos), useWorkerFetch: false, useSystemFonts: false, stopAtErrors: true, standardFontDataUrl: FUENTES_PDF, verbosity: VerbosityLevel.ERRORS })
  let cifrado = false
  tarea.onPassword = () => { cifrado = true; void tarea.destroy() }
  try {
    const pdf = await tarea.promise
    if (pdf.numPages > MAX_PAGINAS_PDF) throw invalido(nombre, `el PDF tiene ${pdf.numPages} páginas; el máximo es ${MAX_PAGINAS_PDF}.`)
    const paginas: string[] = []
    let longitud = 0
    for (let numero = 1; numero <= pdf.numPages; numero++) {
      const pagina = await pdf.getPage(numero)
      const contenido = await pagina.getTextContent()
      const texto = contenido.items.map(item => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '')).join('')
      longitud += texto.length
      if (longitud > MAX_TEXTO_CARACTERES) throw demasiadoTexto(nombre)
      paginas.push(texto)
      pagina.cleanup()
    }
    return paginas.join('\n\n')
  } catch (error) {
    if (error instanceof KdError) throw error
    if (cifrado) throw invalido(nombre, 'el PDF está protegido con contraseña. Carga una copia sin contraseña.')
    throw invalido(nombre, 'no se pudo extraer el texto del PDF: el archivo está dañado o no es un PDF compatible.')
  } finally {
    await tarea.destroy()
  }
}

function demasiadoTexto(nombre: string) {
  return new KdError('FILE_TOO_LARGE', `${nombre}: el texto extraído supera el máximo de ${MAX_TEXTO_CARACTERES.toLocaleString('es')} caracteres. Divide el documento.`)
}

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function decodificarEntidades(texto: string): string {
  return texto.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (completo, entidad: string) => {
    if (entidad[0] === '#') {
      const codigo = entidad[1].toLowerCase() === 'x' ? Number.parseInt(entidad.slice(2), 16) : Number(entidad.slice(1))
      return Number.isInteger(codigo) && codigo > 0 && codigo <= 0x10ffff ? String.fromCodePoint(codigo) : completo
    }
    return ENTIDADES[entidad.toLowerCase()] ?? completo
  })
}

// word/document.xml de WordprocessingML. Cada <w:p> es un párrafo; su texto son
// los <w:t>, con tabulaciones y saltos como espacios. Un estilo de título
// (Heading/Título/Title) se marca con "# " para conservar la estructura.
function textoDocx(nombre: string, datos: Buffer): string {
  if (!empiezaCon(datos, [0x50, 0x4b, 0x03, 0x04])) throw invalido(nombre, 'no es un DOCX: no tiene la estructura ZIP de Word.')
  const partes: Uint8Array[] = []
  let longitud = 0
  let encontrado = false
  let completo = false
  let error: KdError | null = null
  try {
    const zip = new Unzip(archivo => {
      if (archivo.name !== 'word/document.xml') return
      if (encontrado) { error = invalido(nombre, 'el DOCX tiene entradas duplicadas para su contenido.'); return }
      encontrado = true
      // Limitar cada entrada limita también la expansión de un ZIP malicioso.
      if ((archivo.originalSize ?? 0) > MAX_XML_DOCX_BYTES) { error = demasiadoTexto(nombre); return }
      archivo.ondata = (fallo, parte, final) => {
        if (fallo) throw fallo
        longitud += parte.length
        if (longitud > MAX_XML_DOCX_BYTES) { archivo.terminate(); error = demasiadoTexto(nombre); return }
        partes.push(parte)
        completo = final
      }
      archivo.start()
    })
    zip.register(UnzipInflate)
    for (let posicion = 0; posicion < datos.length && !error; posicion += 65_536) zip.push(datos.subarray(posicion, posicion + 65_536), posicion + 65_536 >= datos.length)
  } catch {
    throw invalido(nombre, 'no se pudo leer el DOCX: el archivo está dañado o protegido.')
  }
  if (error) throw error
  if (!encontrado || !completo) throw invalido(nombre, 'no se encontró el documento principal de Word (word/document.xml).')
  const xml = decodificarUtf8(nombre, Buffer.concat(partes))
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw invalido(nombre, 'el DOCX contiene declaraciones XML no admitidas.')
  if (!/<w:document[\s>]/.test(xml)) throw invalido(nombre, 'el XML del DOCX no es un documento de Word válido.')
  const parrafos: string[] = []
  for (const match of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    const cuerpo = match[0]
    const estilo = cuerpo.match(/<w:pStyle\s+w:val="([^"]+)"/)?.[1] ?? ''
    const texto = [...cuerpo.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>/g)]
      .map(match => (match[1] !== undefined ? decodificarEntidades(match[1]) : ' '))
      .join('')
    const esTitulo = /^(heading|t[ií]tulo|title|ttulo)/i.test(estilo)
    parrafos.push(esTitulo && texto.trim() ? `# ${texto.trim()}` : texto)
  }
  return parrafos.join('\n')
}

// Normaliza espacios sin cambiar el contenido y exige texto útil.
function limpiar(nombre: string, texto: string): string {
  if (texto.length > MAX_TEXTO_CARACTERES) throw demasiadoTexto(nombre)
  const limpio = texto.replace(/\r\n?/g, '\n').replace(/[\t  ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!/[\p{L}\p{N}]/u.test(limpio)) {
    throw invalido(nombre, 'no se encontró texto útil en el archivo. Los PDF escaneados necesitan OCR, que no está incluido.')
  }
  return limpio
}

export async function extraerTexto(nombre: string, formato: FormatoTexto, contenido: Buffer): Promise<string> {
  if (contenido.length === 0) throw new KdError('EMPTY_FILE', `${nombre}: el archivo está vacío.`)
  if (formato === 'pdf') return limpiar(nombre, await textoPdf(nombre, contenido))
  if (formato === 'docx') return limpiar(nombre, textoDocx(nombre, contenido))
  return limpiar(nombre, textoTxt(nombre, contenido))
}

// --- Segmentación en bloques --------------------------------------------------

export type ClaseBloque = 'titulo' | 'parrafo' | 'item' | 'pregunta'
export interface Bloque { indice: number; clase: ClaseBloque; texto: string }

const MARCA_LISTA = /^(?:\d{1,3}[.)]|[a-z][.)]|[-*•–])\s+/i
const FIN_ORACION = /[.!?:;]["»”)]?$/

// Un título es una línea corta, sin puntuación final, que empieza en mayúscula o
// número y no es un ítem de lista. "# " (DOCX con estilo de título o Markdown)
// lo marca de forma explícita.
function esTitulo(linea: string): boolean {
  if (/^#{1,6}\s+\S/.test(linea)) return true
  if (linea.length > 90 || FIN_ORACION.test(linea) || /[,]$/.test(linea) || MARCA_LISTA.test(linea)) return false
  if (linea.split(/\s+/).length > 12) return false
  return /^[\p{Lu}\p{N}¿]/u.test(linea)
}

// Agrupa las líneas en bloques. Una línea que no cierra oración continúa en la
// siguiente (los PDF cortan los párrafos por renglón); una línea vacía, un
// título o un ítem de lista abren bloque nuevo.
export function segmentar(texto: string): Bloque[] {
  const bloques: Bloque[] = []
  let actual: { clase: ClaseBloque; lineas: string[] } | null = null
  const cerrar = () => {
    if (!actual) return
    const unido = actual.lineas.join(' ').replace(/\s+/g, ' ').trim()
    if (unido) {
      const clase = actual.clase === 'parrafo' && /\?["»”)]?$/.test(unido) ? 'pregunta' : actual.clase
      bloques.push({ indice: bloques.length + 1, clase, texto: unido })
    }
    actual = null
  }
  const lineas = texto.split('\n').map(linea => linea.trim())
  for (let posicion = 0; posicion < lineas.length; posicion++) {
    const linea = lineas[posicion]
    if (!linea) { cerrar(); continue }
    const enCurso = actual as { clase: ClaseBloque; lineas: string[] } | null
    const continua = enCurso && enCurso.clase !== 'titulo' && !FIN_ORACION.test(enCurso.lineas[enCurso.lineas.length - 1])
    if (continua && !MARCA_LISTA.test(linea) && !/^#{1,6}\s/.test(linea)) { enCurso.lineas.push(linea); continue }
    cerrar()
    // Una línea corta seguida de otra que empieza en minúscula es el comienzo de
    // un párrafo cortado por renglón, no un título.
    const siguienteMinuscula = /^\p{Ll}/u.test(lineas[posicion + 1] ?? '')
    if (esTitulo(linea) && (/^#{1,6}\s/.test(linea) || !siguienteMinuscula)) actual = { clase: 'titulo', lineas: [linea.replace(/^#{1,6}\s+/, '')] }
    else if (MARCA_LISTA.test(linea)) actual = { clase: 'item', lineas: [linea] }
    else actual = { clase: 'parrafo', lineas: [linea] }
    if (actual.clase === 'titulo') cerrar()
  }
  cerrar()
  // Un título sin contenido propio (seguido de otro título o al final) es una
  // línea suelta, como "Versión 1 | Vigencia…": se trata como párrafo. El
  // primer bloque, título del documento, se conserva.
  for (let posicion = 1; posicion < bloques.length; posicion++) {
    const siguiente = bloques[posicion + 1]
    if (bloques[posicion].clase === 'titulo' && (!siguiente || siguiente.clase === 'titulo')) bloques[posicion].clase = 'parrafo'
  }
  // Sin cuerpo posterior (p. ej., un TXT de una sola línea sin punto final como
  // "El empleado debe solicitar el retiro"), el bloque inicial es el contenido
  // y no se descarta como título.
  if (bloques.length && bloques.every(bloque => bloque.clase === 'titulo')) for (const bloque of bloques) bloque.clase = 'parrafo'
  return bloques
}

// --- Clasificación (kd-clasificacion-v1) ------------------------------------
//
// Cada bloque recibe un tipo de fragmento con reglas deterministas y
// documentadas, en este orden de precedencia (gana la primera que aplica):
//   1. faqs: el bloque es una pregunta (termina en "?"); su respuesta, el
//      párrafo siguiente, se une al mismo fragmento.
//   2. steps: ítem de lista numerada, "Paso N"/"Step N", o ítem de lista bajo un
//      título de procedimiento (procedimiento, pasos, proceso, cómo, instrucciones).
//   3. definitions: "se entiende por", "se define(n) como", "significa",
//      "definición", "hace referencia a", "is defined as", "means", "refers to",
//      o "Término: definición" bajo un título de definiciones o glosario.
//   4. eligibility: requisitos, elegibilidad, quién califica o tiene derecho,
//      "pueden solicitar", "aplica a", "dirigido a", eligible, qualify.
//   5. fees_details: montos, valores, tarifas, comisiones o auxilios CON una
//      cifra (dígitos o símbolo de moneda).
//   6. business_rules: obligaciones, plazos y límites (debe, deberá, plazo,
//      máximo, mínimo, obligatorio, prohibido, "no se reembolsa/permite/acepta",
//      "solo se", must, shall, required, not allowed).
//   7. overview: el resto (alcance, objetivo, contexto, vigencia).
// El nivel (tier) sigue al tipo: business_rules y eligibility "high"; steps,
// definitions, fees_details y faqs "medium"; overview "low".

export type TipoFragmentoTexto = 'faqs' | 'steps' | 'definitions' | 'eligibility' | 'fees_details' | 'business_rules' | 'overview'

const TITULO_PROCEDIMIENTO = /\b(procedimiento|pasos|proceso|c[oó]mo|instrucciones|steps|procedure|how to)\b/i
const TITULO_DEFINICIONES = /\b(definiciones|glosario|t[eé]rminos|definitions|glossary)\b/i
const DEFINICION = /\b(se entiende por|se definen? como|significa|definici[oó]n|hace referencia a|is defined as|means|refers to)\b/i
const ELEGIBILIDAD = /\b(requisitos?|elegib\w*|califica\w*|tienen? derecho|pueden solicitar|aplica a|dirigid[oa]s? a|eligib\w*|qualif\w*)\b/i
const IMPORTE = /\b(monto|valor|costo|tarifa|comisi[oó]n|auxilio|importe|precio|fee|fees|cost)\b/i
const CIFRA = /(\d|[$€£])/
const REGLA = /\b(debe|deben|deber[aá]n?|plazo|m[aá]ximo|m[ií]nimo|obligatori\w*|prohibid\w*|no se (?:reembolsa\w*|permite\w*|acepta\w*|reconoce\w*)|solo se|must|shall|required|not allowed)\b/i

export const NIVEL_POR_TIPO: Record<TipoFragmentoTexto, Nivel> = {
  business_rules: 'high', eligibility: 'high', steps: 'medium', definitions: 'medium', fees_details: 'medium', faqs: 'medium', overview: 'low',
}

export function clasificarBloque(bloque: Pick<Bloque, 'clase' | 'texto'>, seccion: string): TipoFragmentoTexto {
  const texto = bloque.texto
  if (bloque.clase === 'pregunta') return 'faqs'
  if (bloque.clase === 'item' && (/^\d{1,3}[.)]\s/.test(texto) || TITULO_PROCEDIMIENTO.test(seccion))) return 'steps'
  if (/^(paso|step)\s*\d/i.test(texto)) return 'steps'
  if (DEFINICION.test(texto) || (TITULO_DEFINICIONES.test(seccion) && /^[^:]{1,60}:\s+\S/.test(texto))) return 'definitions'
  if (ELEGIBILIDAD.test(texto)) return 'eligibility'
  if (IMPORTE.test(texto) && CIFRA.test(texto)) return 'fees_details'
  if (REGLA.test(texto)) return 'business_rules'
  return 'overview'
}

// --- Fragmentación ---------------------------------------------------------

export interface ResultadoTexto { titulo: string; fragmentos: Fragmento[]; bloques: number }

const hash = (texto: string) => createHash('md5').update(texto).digest('hex')

// Agrupa bloques consecutivos de la misma sección y del mismo tipo hasta
// MAX_FRAGMENTO_TEXTO caracteres. Cada fragmento lleva el título de su sección
// (contexto para la búsqueda) y las rutas "bloques[n]" de su origen.
export function fragmentarTexto(texto: string, tituloPorDefecto: string): ResultadoTexto {
  const bloques = segmentar(texto)
  const primero = bloques[0]
  const titulo = (primero?.clase === 'titulo' ? primero.texto : tituloPorDefecto).slice(0, 500)
  interface Grupo { seccion: string; tipo: TipoFragmentoTexto; bloques: Bloque[] }
  const grupos: Grupo[] = []
  let seccion = titulo
  let pendientePregunta: Grupo | null = null
  for (const bloque of bloques) {
    if (bloque.clase === 'titulo') {
      if (bloque === primero) continue
      seccion = bloque.texto
      pendientePregunta = null
      continue
    }
    // La respuesta de una pregunta va en el mismo fragmento que la pregunta.
    if (pendientePregunta && bloque.clase === 'parrafo') {
      pendientePregunta.bloques.push(bloque)
      pendientePregunta = null
      continue
    }
    const tipo = clasificarBloque(bloque, seccion)
    const ultimo = grupos[grupos.length - 1]
    const largo = (grupo: Grupo) => grupo.bloques.reduce((total, item) => total + item.texto.length + 1, 0)
    if (tipo !== 'faqs' && ultimo && ultimo.seccion === seccion && ultimo.tipo === tipo && largo(ultimo) + bloque.texto.length <= MAX_FRAGMENTO_TEXTO) {
      ultimo.bloques.push(bloque)
    } else {
      grupos.push({ seccion, tipo, bloques: [bloque] })
    }
    pendientePregunta = tipo === 'faqs' ? grupos[grupos.length - 1] : null
  }

  const fragmentos: Fragmento[] = []
  for (const grupo of grupos) {
    const contenido = grupo.bloques.map(bloque => bloque.texto).join('\n')
    const rutas = grupo.bloques.map(bloque => `bloques[${bloque.indice}]`)
    const encabezado = grupo.seccion === titulo ? titulo : `${titulo} — ${grupo.seccion}`
    const partes = partir(contenido, MAX_FRAGMENTO_TEXTO)
    partes.forEach((parte, posicion) => {
      const textoFragmento = `${encabezado}\n${parte}`
      fragmentos.push({
        indice: fragmentos.length + 1,
        texto: textoFragmento,
        tipo: grupo.tipo,
        categoria: grupo.seccion,
        nivel: NIVEL_POR_TIPO[grupo.tipo],
        temas: [],
        rutas,
        parte: partes.length > 1 ? [posicion + 1, partes.length] : null,
        hash: hash(textoFragmento),
        extra: {},
      })
    })
  }
  return { titulo, fragmentos, bloques: bloques.length }
}

// Identidad de un documento de texto. No tiene metadata.article_id: se deriva
// del nombre del archivo con su extensión, así un PDF, un DOCX y un TXT con el
// mismo nombre base son documentos distintos.
export function identidadTexto(nombre: string, formato: FormatoTexto, titulo: string): IdentidadArticulo {
  const base = nombre.slice(0, nombre.length - formato.length - 1)
  const slug = base.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 180) || 'documento'
  const avisos = formato === 'pdf' ? ['Texto extraído del PDF sin OCR: las imágenes y el texto escaneado no se indexan.'] : []
  return { id: `${slug}_${formato}`, titulo, recordKeeper: null, planType: null, schemaVersion: null, avisos }
}
