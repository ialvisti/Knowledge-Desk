import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

export type TipoLocal = 'pdf' | 'docx' | 'txt' | 'json'
export interface FragmentoLocal { id: string; texto: string }
export interface DocumentoLocal {
  id: string
  nombre: string
  tipo: TipoLocal
  bytes: number
  fechaCarga: string
  version: number
  fragmentos: FragmentoLocal[]
  texto: string
  sha256: string
  archivo: Blob
}
export interface RegistroLocal {
  id: string
  documentoId: string
  documentoNombre: string
  tipo: 'carga' | 'reemplazo' | 'eliminacion'
  fecha: string
  version: number
  resultado: 'exitoso'
  fragmentos: number
}

export const MAX_BYTES_LOCAL = 50 * 1024 * 1024
export const FORMATOS_LOCAL = ['pdf', 'docx', 'txt', 'json'] as const
const BASE = 'knowledge-desk-local'
const MAX_TEXTO = 20 * 1024 * 1024
const OYENTES = new Set<() => void>()
let canal: BroadcastChannel | null = null

function escucharCanal() {
  if (!canal && typeof BroadcastChannel !== 'undefined') {
    canal = new BroadcastChannel(BASE)
    canal.onmessage = () => OYENTES.forEach(oyente => oyente())
  }
}

function avisar() {
  OYENTES.forEach(oyente => oyente())
  escucharCanal()
  canal?.postMessage('cambio')
}

export function suscribirLocales(callback: () => void): () => void {
  escucharCanal()
  OYENTES.add(callback)
  return () => { OYENTES.delete(callback) }
}

export function mensajeErrorLocal(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'QuotaExceededError') return 'No hay espacio suficiente en este navegador. Libera espacio o elimina un documento y vuelve a intentarlo.'
    if (error.name === 'SecurityError' || error.name === 'InvalidStateError') return 'El navegador no permite guardar datos locales. Usa una ventana normal y permite el almacenamiento de este sitio.'
    if (error.name === 'AbortError') return 'No se pudo completar el guardado local. No se aplicaron cambios; vuelve a intentarlo.'
  }
  return error instanceof Error ? error.message : 'No se pudo completar la operación en el almacenamiento local. Vuelve a intentarlo.'
}

function extension(nombre: string): string { return nombre.slice(nombre.lastIndexOf('.') + 1).toLowerCase() }

export function validarArchivoLocal(archivo: Pick<File, 'name' | 'size'>): string | null {
  if (!(FORMATOS_LOCAL as readonly string[]).includes(extension(archivo.name))) return `${archivo.name}: formato no admitido. Usa PDF, DOCX, TXT o JSON de conocimiento.`
  if (archivo.size === 0) return `${archivo.name}: el archivo está vacío.`
  if (archivo.size > MAX_BYTES_LOCAL) return `${archivo.name}: supera el límite de 50 MB.`
  return null
}

function abrirBase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Este navegador no dispone de almacenamiento IndexedDB.')); return }
    let solicitud: IDBOpenDBRequest
    try { solicitud = indexedDB.open(BASE, 1) } catch (error) { reject(error); return }
    let terminada = false
    solicitud.onupgradeneeded = () => {
      const db = solicitud.result
      if (!db.objectStoreNames.contains('documentos')) db.createObjectStore('documentos', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('registros')) db.createObjectStore('registros', { keyPath: 'id' })
    }
    solicitud.onblocked = () => {
      terminada = true
      reject(new Error('Otra pestaña impide abrir el almacenamiento local. Cierra las otras pestañas de Knowledge Desk y reintenta.'))
    }
    solicitud.onerror = () => { terminada = true; reject(solicitud.error) }
    solicitud.onsuccess = () => {
      const db = solicitud.result
      if (terminada) { db.close(); return }
      db.onversionchange = () => db.close()
      resolve(db)
    }
  })
}

async function leer<T>(almacen: string, id?: string): Promise<T> {
  const db = await abrirBase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(almacen, 'readonly')
      const peticion = id === undefined ? tx.objectStore(almacen).getAll() : tx.objectStore(almacen).get(id)
      tx.oncomplete = () => resolve(peticion.result as T)
      tx.onabort = tx.onerror = () => reject(tx.error ?? peticion.error ?? new Error('No se pudo leer el almacenamiento local.'))
    })
  } finally { db.close() }
}

export async function listarLocales(): Promise<DocumentoLocal[]> {
  return (await leer<DocumentoLocal[]>('documentos')).sort((a, b) => b.fechaCarga.localeCompare(a.fechaCarga))
}
export async function obtenerLocal(id: string): Promise<DocumentoLocal | null> { return await leer<DocumentoLocal | undefined>('documentos', id) ?? null }
export async function listarRegistrosLocales(): Promise<RegistroLocal[]> {
  return (await leer<RegistroLocal[]>('registros')).sort((a, b) => b.fecha.localeCompare(a.fecha))
}

function limpiarTexto(texto: string): string {
  if (texto.length > MAX_TEXTO) throw new Error('El texto extraído es demasiado grande para procesarlo en este navegador (máximo 20 MB de texto).')
  const limpio = texto.replace(/\r\n?/g, '\n').replace(/[\t \u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (!/[\p{L}\p{N}]/u.test(limpio)) throw new Error('No se encontró texto útil en el archivo. Los PDF escaneados necesitan OCR, que no está incluido en esta demostración.')
  return limpio
}

function decodificar(datos: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(datos) }
  catch { throw new Error('No se pudo leer el texto. Guarda el archivo como UTF-8 e inténtalo de nuevo.') }
}

async function textoPdf(datos: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  const tarea = pdfjs.getDocument({ data: datos, useWorkerFetch: false, useSystemFonts: true, stopAtErrors: true })
  let cifrado = false
  tarea.onPassword = () => { cifrado = true; void tarea.destroy() }
  try {
    const pdf = await tarea.promise
    const paginas: string[] = []
    let longitud = 0
    for (let numero = 1; numero <= pdf.numPages; numero++) {
      const pagina = await pdf.getPage(numero)
      const contenido = await pagina.getTextContent()
      const texto = contenido.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('')
      longitud += texto.length
      if (longitud > MAX_TEXTO) throw new Error('El texto del PDF supera el máximo local de 20 MB. Divide el documento e inténtalo de nuevo.')
      paginas.push(texto)
      pagina.cleanup()
    }
    return paginas.join('\n\n')
  } catch (error) {
    if (cifrado) throw new Error('El PDF está protegido con contraseña. Carga una copia sin contraseña.')
    if (error instanceof Error && error.message.includes('20 MB')) throw error
    throw new Error('No se pudo extraer el texto del PDF. El archivo está dañado o no es un PDF compatible.')
  } finally { await tarea.destroy() }
}

async function textoDocx(datos: Uint8Array): Promise<string> {
  const { Unzip, UnzipInflate } = await import('fflate')
  const partes: Uint8Array[] = []
  let longitud = 0
  let encontrado = false
  let completo = false
  try {
    const zip = new Unzip(archivo => {
      if (archivo.name !== 'word/document.xml') return
      if (encontrado) throw new Error('El DOCX tiene entradas duplicadas para su contenido.')
      encontrado = true
      if ((archivo.originalSize ?? 0) > MAX_TEXTO) throw new Error('El contenido XML del DOCX supera el máximo local de 20 MB.')
      archivo.ondata = (error, parte, final) => {
        if (error) throw error
        longitud += parte.length
        if (longitud > MAX_TEXTO) { archivo.terminate(); throw new Error('El contenido XML del DOCX supera el máximo local de 20 MB.') }
        partes.push(parte)
        completo = final
      }
      archivo.start()
    })
    zip.register(UnzipInflate)
    // Limitar cada entrada limita también la expansión de un ZIP malicioso.
    for (let posicion = 0; posicion < datos.length; posicion += 4096) zip.push(datos.subarray(posicion, posicion + 4096), posicion + 4096 >= datos.length)
    if (!encontrado || !completo) throw new Error('No se encontró el documento principal en el DOCX.')
    const unido = new Uint8Array(longitud)
    let offset = 0
    for (const parte of partes) { unido.set(parte, offset); offset += parte.length }
    const xml = decodificar(unido)
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('El DOCX contiene declaraciones XML no admitidas.')
    const documento = new DOMParser().parseFromString(xml, 'application/xml')
    if (documento.querySelector('parsererror') || documento.documentElement.localName !== 'document') throw new Error('El XML del DOCX no es válido.')
    const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    return Array.from(documento.getElementsByTagNameNS(ns, 'p')).map(parrafo => {
      return Array.from(parrafo.getElementsByTagNameNS(ns, '*')).map(elemento => {
        if (elemento.localName === 't') return elemento.textContent ?? ''
        return ['tab', 'br', 'cr'].includes(elemento.localName) ? ' ' : ''
      }).join('')
    }).join('\n')
  } catch (error) {
    if (error instanceof Error && (error.message.includes('20 MB') || error.message.includes('declaraciones XML'))) throw error
    throw new Error('No se pudo extraer el texto del DOCX. El archivo está dañado, protegido o no contiene un documento de Word válido.')
  }
}

function objeto(valor: unknown): valor is Record<string, unknown> { return typeof valor === 'object' && valor !== null && !Array.isArray(valor) }

function textoJson(datos: Uint8Array): string {
  let valor: unknown
  try { valor = JSON.parse(decodificar(datos)) } catch { throw new Error('El archivo no contiene JSON válido en UTF-8.') }
  if (!objeto(valor) || !objeto(valor.metadata) || !objeto(valor.details)) throw new Error('El JSON debe contener metadata y details del esquema de artículos de conocimiento kb_article_v2.')
  if (typeof valor.metadata.article_id !== 'string' || !valor.metadata.article_id.trim() || typeof valor.metadata.title !== 'string' || !valor.metadata.title.trim()) throw new Error('El artículo JSON necesita metadata.article_id y metadata.title no vacíos.')
  const textos: string[] = []
  const pendientes: { valor: unknown; nivel: number }[] = [{ valor: valor.details, nivel: 0 }]
  while (pendientes.length) {
    const actual = pendientes.pop()!
    if (actual.nivel > 100) throw new Error('El JSON tiene demasiados niveles anidados.')
    if (typeof actual.valor === 'string' && actual.valor.trim()) textos.push(actual.valor)
    else if (typeof actual.valor === 'number') textos.push(String(actual.valor))
    else if (Array.isArray(actual.valor) || objeto(actual.valor)) {
      for (const item of Object.values(actual.valor).reverse()) pendientes.push({ valor: item, nivel: actual.nivel + 1 })
    }
  }
  if (!textos.some(texto => /\p{L}/u.test(texto))) throw new Error('El artículo JSON no tiene texto útil en details.')
  return [valor.metadata.title, ...textos].join('\n')
}

async function extraer(datos: Uint8Array, tipo: TipoLocal): Promise<string> {
  if (tipo === 'pdf') return limpiarTexto(await textoPdf(datos))
  if (tipo === 'docx') return limpiarTexto(await textoDocx(datos))
  if (tipo === 'json') return limpiarTexto(textoJson(datos))
  const texto = decodificar(datos)
  for (let indice = 0; indice < texto.length; indice++) {
    const codigo = texto.charCodeAt(indice)
    if (codigo < 9 || (codigo > 13 && codigo < 32)) throw new Error('El TXT contiene datos binarios. Carga un archivo de texto UTF-8.')
  }
  return limpiarTexto(texto)
}

function fragmentar(texto: string, prefijo: string): FragmentoLocal[] {
  const fragmentos: FragmentoLocal[] = []
  let posicion = 0
  while (posicion < texto.length) {
    let fin = Math.min(posicion + 1400, texto.length)
    if (fin < texto.length) {
      const corte = Math.max(texto.lastIndexOf('\n', fin), texto.lastIndexOf('. ', fin), texto.lastIndexOf(' ', fin))
      if (corte > posicion + 700) fin = corte + 1
    }
    fragmentos.push({ id: `${prefijo}-${fragmentos.length + 1}`, texto: texto.slice(posicion, fin).trim() })
    if (fin === texto.length) break
    posicion = fin - 100
  }
  return fragmentos
}

export async function guardarLocal(archivo: File, reemplazarId?: string): Promise<{ documento: DocumentoLocal; registro: RegistroLocal }> {
  const invalido = validarArchivoLocal(archivo)
  if (invalido) throw new Error(invalido)
  const anterior = reemplazarId ? await obtenerLocal(reemplazarId) : null
  if (reemplazarId && !anterior) throw new Error('El documento ya no existe. Actualiza la lista antes de reemplazarlo.')
  const id = anterior?.id ?? crypto.randomUUID()
  const version = (anterior?.version ?? 0) + 1
  const fecha = new Date().toISOString()
  const bytes = await archivo.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  const tipo = extension(archivo.name) as TipoLocal
  // Todo el trabajo asíncrono se completa antes de abrir la transacción de escritura.
  const texto = await extraer(new Uint8Array(bytes), tipo)
  const documento: DocumentoLocal = { id, nombre: archivo.name, tipo, bytes: archivo.size, fechaCarga: fecha, version, fragmentos: fragmentar(texto, `${id}-v${version}`), texto, sha256, archivo: archivo.slice(0, archivo.size, archivo.type) }
  const registro: RegistroLocal = { id: crypto.randomUUID(), documentoId: id, documentoNombre: archivo.name, tipo: anterior ? 'reemplazo' : 'carga', fecha, version, resultado: 'exitoso', fragmentos: documento.fragmentos.length }
  const db = await abrirBase()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['documentos', 'registros'], 'readwrite')
      let conflicto: unknown = null
      tx.oncomplete = () => resolve()
      tx.onabort = tx.onerror = () => reject(conflicto ?? tx.error ?? new Error('No se pudo guardar el documento.'))
      const documentos = tx.objectStore('documentos')
      const escribir = () => {
        try { documentos.put(documento); tx.objectStore('registros').put(registro) }
        catch (error) { conflicto = error; tx.abort() }
      }
      if (!anterior) escribir()
      else {
        const lectura = documentos.get(id)
        lectura.onsuccess = () => {
          const vigente = lectura.result as DocumentoLocal | undefined
          if (!vigente || vigente.version !== anterior.version || vigente.sha256 !== anterior.sha256) {
            conflicto = new Error('El documento cambió o se eliminó en otra pestaña. Actualiza la lista antes de reemplazarlo.')
            tx.abort()
          } else escribir()
        }
      }
    })
  } finally { db.close() }
  avisar()
  return { documento, registro }
}

export async function eliminarLocal(id: string): Promise<RegistroLocal> {
  const db = await abrirBase()
  let registro: RegistroLocal | null = null
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['documentos', 'registros'], 'readwrite')
      let fallo: unknown = null
      tx.oncomplete = () => resolve()
      tx.onabort = tx.onerror = () => reject(fallo ?? tx.error ?? new Error('No se pudo eliminar el documento.'))
      const store = tx.objectStore('documentos')
      const lectura = store.get(id)
      lectura.onsuccess = () => {
        const documento = lectura.result as DocumentoLocal | undefined
        if (!documento) { fallo = new Error('El documento ya no existe. Actualiza la lista.'); tx.abort(); return }
        registro = { id: crypto.randomUUID(), documentoId: id, documentoNombre: documento.nombre, tipo: 'eliminacion', fecha: new Date().toISOString(), version: documento.version, resultado: 'exitoso', fragmentos: documento.fragmentos.length }
        try { store.delete(id); tx.objectStore('registros').put(registro) }
        catch (error) { fallo = error; tx.abort() }
      }
    })
  } finally { db.close() }
  avisar()
  return registro!
}

const VACIAS = new Set('a al algo ante bajo como con contra cual cuales cuando de del desde donde dos el ella en entre era es esa ese eso esta este esto fue ha hasta hay la las le les lo los mas me mi muy no nos o para pero por porque que quien se si sin sobre son su sus te tiene tu un una uno unos unas y ya cual cuanto puedo debo hacer'.split(' '))
function terminos(texto: string): string[] {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]{2,}/g)?.filter(token => !VACIAS.has(token)) ?? []
}

export async function buscarLocales(pregunta: string): Promise<{ documento: DocumentoLocal; fragmento: FragmentoLocal; puntuacion: number }[]> {
  const consulta = [...new Set(terminos(pregunta))]
  if (!consulta.length) return []
  const documentos = await listarLocales()
  const candidatos = documentos.flatMap(documento => documento.fragmentos.map(fragmento => ({ documento, fragmento, tokens: terminos(fragmento.texto) })))
  const frecuencias = new Map<string, number>()
  for (const termino of consulta) frecuencias.set(termino, candidatos.filter(candidato => candidato.tokens.includes(termino)).length)
  const resultados = candidatos.map(({ documento, fragmento, tokens }) => {
    const encontrados = consulta.filter(termino => tokens.includes(termino))
    const puntuacion = encontrados.reduce((suma, termino) => suma + Math.log(1 + candidatos.length / (frecuencias.get(termino) || 1)) * (1 + Math.log(tokens.filter(token => token === termino).length)), 0) / Math.sqrt(Math.max(tokens.length, 1))
    return { documento, fragmento, puntuacion, coincidencias: encontrados.length }
  })
  // Se exige al menos la mitad de los términos, además de una coincidencia real.
  return resultados.filter(resultado => resultado.coincidencias >= Math.max(1, Math.ceil(consulta.length / 2)))
    .sort((a, b) => b.puntuacion - a.puntuacion).slice(0, 8)
    .map(({ documento, fragmento, puntuacion }) => ({ documento, fragmento, puntuacion }))
}
