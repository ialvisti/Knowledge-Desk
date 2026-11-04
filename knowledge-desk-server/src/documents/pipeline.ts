import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { KdError } from '../errors.ts'
import { chunkId, documentoId, operacionId, prefijoDocumento, prefijoVersion } from '../ids.ts'
import type { IndiceCorpus, RegistroIndice, ValorMetadato } from '../index/types.ts'
import { leerJson, nombreSeguro, validarArchivoArticulo, validarArticulo, type Articulo, type ResumenArticulo } from './articulo.ts'
import { REGLA_FRAGMENTACION, contenidoUtil, fragmentarArticulo, type Fragmento } from './chunker.ts'
import { crearVersion, nuevaVersion, type Documento, type IdentidadArticulo, type Operacion, type PasoOperacion, type Registro, type TipoOperacion, type Version } from './store.ts'
import { REGLA_CLASIFICACION, REGLA_TEXTO, detectarFormato, extraerTexto, fragmentarTexto, identidadTexto, type FormatoDocumento, type FormatoTexto } from './texto.ts'

export interface OpcionesGestor {
  maxUploadBytes: number
  verificacionIndiceMs: number
  verificacionIntervaloMs: number
  // Solo en modo forusguide el índice del gestor es el corpus de ForUsGuide y
  // tiene sentido comprobar si un artículo JSON ya existe allí.
  verificarCorpusExterno?: boolean
}

// Lo que se sabe de un archivo tras validarlo, antes de registrarlo.
interface Entrada {
  formato: FormatoDocumento
  identidad: IdentidadArticulo
  // Solo JSON: el resumen del artículo, para la comprobación de duplicados externos.
  resumen: ResumenArticulo | null
  // Solo texto: lo extraído en la validación.
  texto: { caracteres: number; bloques: number; fragmentos: number } | null
}

const NOMBRE_FORMATO: Record<FormatoDocumento, string> = { json: 'JSON kb_article_v2', pdf: 'PDF', docx: 'DOCX', txt: 'TXT' }

export interface ArchivoRecibido { nombre: string; contenido: Buffer }

export interface Log { info(objeto: object, mensaje: string): void; warn(objeto: object, mensaje: string): void; error(objeto: object, mensaje: string): void }
const silencio: Log = { info() {}, warn() {}, error() {} }

const esperar = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const peso = (version: string) => version.split('.').map(Number).reduce((mayor, menor) => mayor * 1000 + menor)

function identidad(resumen: ResumenArticulo): IdentidadArticulo {
  return { id: resumen.id, titulo: resumen.titulo, recordKeeper: resumen.recordKeeper, planType: resumen.planType, schemaVersion: resumen.schemaVersion, avisos: resumen.avisos }
}

const textos = (valor: unknown): string[] => (Array.isArray(valor) ? valor.filter((item): item is string => typeof item === 'string') : [])

// Pinecone limita los metadatos a 40 KB por registro. Los textos libres del
// artículo se acotan aquí; el texto completo vive en el fragmento y en el JSON.
const corto = (valor: string, maximo = 200) => (valor.length > maximo ? `${valor.slice(0, maximo - 1)}…` : valor)
const cortos = (valores: string[]) => valores.slice(0, 50).map(valor => corto(valor))

// Registro de un fragmento de PDF, DOCX o TXT: mismos campos de identidad y
// fragmento que los artículos JSON, sin los metadatos propios de kb_article_v2.
function registroDeTexto(docId: string, version: Version, fragmento: Fragmento): RegistroIndice {
  return {
    id: chunkId(docId, version.version, fragmento.indice),
    texto: fragmento.texto,
    metadata: {
      article_id: version.articleId,
      article_title: version.articulo.titulo,
      record_keeper: 'all',
      plan_type: 'all',
      chunk_type: fragmento.tipo,
      chunk_category: corto(fragmento.categoria),
      chunk_index: fragmento.indice,
      chunk_tier: fragmento.nivel,
      content_hash: fragmento.hash,
      source: 'knowledge-desk',
      source_article_id: version.articulo.id,
      kd_document_id: docId,
      kd_version: version.version,
      kd_file_name: version.archivo.nombre,
      kd_format: version.archivo.tipo,
      ...(fragmento.parte ? { kd_part: `${fragmento.parte[0]}/${fragmento.parte[1]}` } : {}),
    },
  }
}

// Registro para el índice. Los metadatos siguen al chunker de ForUsGuide
// (article_title, description, record_keeper/plan_type con el centinela "all",
// scope, tags, topic, subtopics, chunk_*, specific_topics, content_hash…), así el
// motor knowledge-question los trata igual que a su propio corpus. article_id es
// el identificador INTERNO de la versión (kd_…): aísla versiones en el índice y
// nunca pisa los IDs de ForUsGuide. El ID canónico del artículo viaja aparte.
function registroDeFragmento(docId: string, version: Version, articulo: Articulo, fragmento: Fragmento): RegistroIndice {
  const meta = articulo.metadata
  const metadata: Record<string, ValorMetadato> = {
    article_id: version.articleId,
    article_title: version.articulo.titulo,
    record_keeper: version.articulo.recordKeeper ?? 'all',
    plan_type: version.articulo.planType ?? 'all',
    tags: cortos(textos(meta.tags)),
    subtopics: cortos(textos(meta.subtopics)),
    chunk_type: fragmento.tipo,
    chunk_category: corto(fragmento.categoria),
    chunk_index: fragmento.indice,
    chunk_tier: fragmento.nivel,
    specific_topics: cortos(fragmento.temas),
    content_hash: fragmento.hash,
    source: 'knowledge-desk',
    source_article_id: version.articulo.id,
    kd_document_id: docId,
    kd_version: version.version,
    kd_file_name: version.archivo.nombre,
    kd_json_paths: fragmento.rutas,
  }
  for (const [clave, valores] of Object.entries(fragmento.extra)) metadata[clave] = cortos(valores)
  for (const clave of ['description', 'scope', 'topic'] as const) {
    if (typeof meta[clave] === 'string') metadata[clave] = corto(meta[clave] as string, clave === 'description' ? 1000 : 200)
  }
  if (fragmento.parte) metadata.kd_part = `${fragmento.parte[0]}/${fragmento.parte[1]}`
  return { id: chunkId(docId, version.version, fragmento.indice), texto: fragmento.texto, metadata }
}

const resumenTexto = (entrada: Entrada) => (entrada.texto ? { caracteres: entrada.texto.caracteres, bloques: entrada.texto.bloques } : null)

interface Progreso { fragmentosTotal: number | null; embeddingsTotal: number | null; fragmentosRestantes: number | null; embeddingsRestantes: number | null }

export class GestorDocumentos {
  private readonly registro: Registro
  private readonly indice: IndiceCorpus | null
  private readonly opciones: OpcionesGestor
  private readonly ahora: () => Date
  private readonly log: Log
  private cola: Promise<unknown> = Promise.resolve()

  constructor(registro: Registro, indice: IndiceCorpus | null, opciones: OpcionesGestor, extras: { ahora?: () => Date; log?: Log } = {}) {
    this.registro = registro
    this.indice = indice
    this.opciones = opciones
    this.ahora = extras.ahora ?? (() => new Date())
    this.log = extras.log ?? silencio
  }

  get indexacionConfigurada() { return this.indice !== null }

  // Espera a que terminen las operaciones en segundo plano (pruebas y apagado).
  async esperarInactividad() {
    let actual: Promise<unknown>
    do {
      actual = this.cola
      await actual
    } while (actual !== this.cola)
  }

  listar(): Documento[] {
    return this.registro.documentos().filter(doc => doc.estado !== 'retirado')
  }

  private fecha() { return this.ahora().toISOString() }

  private nuevaOperacion(estado: { secuencias: { operacion: number }; operaciones: Operacion[] }, tipo: TipoOperacion, doc: Documento, version: string | null, versionAnterior: string | null, operador: string): string {
    estado.secuencias.operacion += 1
    const id = operacionId(estado.secuencias.operacion, this.ahora())
    estado.operaciones.push({
      id, tipo, documentoId: doc.id, documentoNombre: doc.nombre, version, versionAnterior, operador,
      inicio: this.fecha(), fin: null, resultado: 'en_curso', mensaje: null, contadores: {}, pasos: [],
    })
    return id
  }

  private paso(opId: string, nombre: string, estadoPaso: PasoOperacion['estado'], detalle: string) {
    return this.registro.mutar(estado => {
      estado.operaciones.find(op => op.id === opId)?.pasos.push({ nombre, estado: estadoPaso, detalle, en: this.fecha() })
    })
  }

  private encolar(trabajo: () => Promise<void>) {
    const tarea = this.cola.then(trabajo).catch(error => this.log.error({ err: (error as Error).name }, 'fallo inesperado en la cola de documentos'))
    this.cola = tarea
  }

  private exigirIndice(nombre: string): IndiceCorpus {
    if (!this.indice) throw new KdError('INDEX_NOT_CONFIGURED', `${nombre}: no es posible indexarlo porque la integración con el índice no está configurada.`)
    return this.indice
  }

  // El corpus de ForUsGuide usa como prefijo de sus fragmentos el article_id
  // canónico. Si ya existe, este artículo duplicaría contenido gestionado fuera.
  private async exigirFueraDelCorpusExterno(resumen: ResumenArticulo, nombre: string) {
    if (!this.indice || this.indice.tipo !== 'pinecone') return
    const existentes = await this.indice.listarIds(`${resumen.id}_chunk_`)
    if (existentes.length) {
      throw new KdError('DUPLICATE_ARTICLE', `${nombre}: el artículo "${resumen.id}" ya existe en el corpus de ForUsGuide y se gestiona fuera de Knowledge Desk.`)
    }
  }

  // --- Carga (HU07) --------------------------------------------------------

  // Valida tamaño, formato y contenido SIN tocar el registro, el disco ni el
  // índice: un archivo rechazado (por ejemplo, una imagen PNG) no deja nada.
  private async validarEntrada(nombre: string, contenido: Buffer): Promise<Entrada> {
    if (contenido.length === 0) throw new KdError('EMPTY_FILE', `${nombre}: el archivo está vacío.`)
    if (contenido.length > this.opciones.maxUploadBytes) throw new KdError('FILE_TOO_LARGE', `${nombre}: supera el límite de ${Math.round(this.opciones.maxUploadBytes / 1024 / 1024)} MB.`)
    const formato = detectarFormato(nombre, contenido)
    if (formato === 'json') {
      const { resumen } = validarArchivoArticulo(nombre, contenido, this.opciones.maxUploadBytes)
      return { formato, identidad: identidad(resumen), resumen, texto: null }
    }
    const texto = await extraerTexto(nombre, formato, contenido)
    const resultado = fragmentarTexto(texto, nombre)
    if (!resultado.fragmentos.length) throw new KdError('INVALID_DOCUMENT', `${nombre}: el texto no produjo fragmentos con contenido.`)
    return {
      formato, identidad: identidadTexto(nombre, formato, resultado.titulo), resumen: null,
      texto: { caracteres: texto.length, bloques: resultado.bloques, fragmentos: resultado.fragmentos.length },
    }
  }

  async cargar(archivo: ArchivoRecibido, operador: string) {
    const nombre = nombreSeguro(archivo.nombre)
    const entrada = await this.validarEntrada(nombre, archivo.contenido)
    this.exigirIndice(nombre)
    if (entrada.resumen && this.opciones.verificarCorpusExterno !== false) await this.exigirFueraDelCorpusExterno(entrada.resumen, nombre)
    const sha256 = createHash('sha256').update(archivo.contenido).digest('hex')
    const ahora = this.fecha()

    // Alta y reserva en una sola mutación: dos cargas simultáneas no pueden
    // crear dos documentos con el mismo nombre ni con el mismo artículo.
    const { id, opId } = await this.registro.mutar(estado => {
      for (const doc of estado.documentos) {
        if (doc.estado === 'retirado') continue
        if (doc.nombre.toLowerCase() === nombre.toLowerCase()) throw new KdError('DUPLICATE_DOCUMENT', `${nombre}: ya existe un documento con ese nombre. Usa Editar para reemplazarlo.`)
        const actual = doc.versiones.find(version => version.version === doc.versionActiva) ?? doc.versiones[doc.versiones.length - 1]
        if (actual?.articulo?.id === entrada.identidad.id) throw new KdError('DUPLICATE_ARTICLE', `${nombre}: el artículo "${entrada.identidad.id}" ya está en ${doc.id} (${doc.nombre}). Usa Editar para reemplazarlo.`)
      }
      estado.secuencias.documento += 1
      const nuevoId = documentoId(estado.secuencias.documento)
      const ruta = path.join('archivos', nuevoId, 'v1.0', nombre)
      const documento: Documento = {
        id: nuevoId, nombre, estado: 'procesando', versionActiva: null,
        versiones: [{ ...crearVersion(nuevoId, '1.0', { nombre, ruta, bytes: archivo.contenido.length, tipo: entrada.formato, sha256 }, entrada.identidad, ahora), texto: resumenTexto(entrada) }],
        error: null, operacionEnCurso: null, eliminacion: null, creadoEn: ahora, actualizadoEn: ahora, retiradoEn: null,
      }
      estado.documentos.push(documento)
      const nuevaOp = this.nuevaOperacion(estado, 'carga', documento, '1.0', null, operador)
      documento.operacionEnCurso = nuevaOp
      return { id: nuevoId, opId: nuevaOp }
    })
    await this.almacenarYProcesar(id, '1.0', nombre, archivo.contenido, opId, 'carga', entrada, sha256)
    return { documento: this.registro.documento(id)!, operacion: this.registro.operacion(opId)! }
  }

  private async almacenarYProcesar(docId: string, version: string, nombre: string, contenido: Buffer, opId: string, tipoOp: TipoOperacion, entrada: Entrada, sha256: string) {
    try {
      // Los bytes del original se guardan sin modificar: son lo que se muestra,
      // se copia y se descarga como JSON auténtico de esa versión.
      await this.registro.guardarArchivo(docId, version, nombre, contenido)
    } catch {
      await this.fallar(docId, version, opId, 'almacenamiento', 'No se pudo guardar el archivo original en el servidor.', false)
      return
    }
    const avisos = entrada.identidad.avisos.length ? ` Avisos: ${entrada.identidad.avisos.join(' ')}` : ''
    const detalle = entrada.texto ? ` · ${entrada.texto.caracteres} caracteres de texto extraídos` : ''
    await this.paso(opId, 'validacion', 'ok', `${NOMBRE_FORMATO[entrada.formato]} válido · ${entrada.formato === 'json' ? 'artículo' : 'documento'} ${entrada.identidad.id}${detalle} · ${contenido.length} bytes · SHA-256 ${sha256.slice(0, 12)}…${avisos}`)
    this.encolar(() => this.procesar(docId, version, opId, tipoOp))
  }

  // --- Reemplazo (HU08) ----------------------------------------------------

  async reemplazar(docId: string, archivo: ArchivoRecibido, operador: string) {
    const nombre = nombreSeguro(archivo.nombre)
    const entrada = await this.validarEntrada(nombre, archivo.contenido)
    this.exigirIndice(nombre)
    const sha256 = createHash('sha256').update(archivo.contenido).digest('hex')
    const ahora = this.fecha()

    const { opId, version } = await this.registro.mutar(estado => {
      const doc = estado.documentos.find(item => item.id === docId)
      if (!doc || doc.estado === 'retirado') throw new KdError('NOT_FOUND', 'El documento no existe o ya fue retirado.')
      if (doc.operacionEnCurso) throw new KdError('DOCUMENT_BUSY')
      if (doc.estado !== 'indexado' && doc.estado !== 'error') throw new KdError('INVALID_STATE', 'Solo se puede reemplazar un documento indexado o con error.')
      // HU08: la nueva versión debe ser del MISMO artículo; otro artículo se carga aparte.
      const vigente = doc.versiones.find(item => item.version === doc.versionActiva) ?? doc.versiones[doc.versiones.length - 1]
      // Un documento de texto (PDF, DOCX, TXT) se reemplaza por otro documento de
      // texto y conserva su identidad; un artículo JSON, por el mismo artículo.
      const textoVigente = vigente.archivo.tipo !== 'json'
      if (textoVigente !== (entrada.formato !== 'json')) {
        throw new KdError('ARTICLE_MISMATCH', textoVigente
          ? `${nombre}: un documento PDF, DOCX o TXT solo se reemplaza por otro documento PDF, DOCX o TXT.`
          : `${nombre}: un artículo JSON solo se reemplaza por una nueva versión JSON del mismo artículo.`)
      }
      if (!textoVigente && vigente.articulo.id !== entrada.identidad.id) {
        throw new KdError('ARTICLE_MISMATCH', `${nombre}: corresponde al artículo "${entrada.identidad.id}" y el documento ${docId} es "${vigente.articulo.id}".`)
      }
      const identidadNueva = textoVigente ? { ...entrada.identidad, id: vigente.articulo.id } : entrada.identidad
      const duplicado = estado.documentos.some(otro => otro.id !== docId && otro.estado !== 'retirado' && otro.nombre.toLowerCase() === nombre.toLowerCase())
      if (duplicado) throw new KdError('DUPLICATE_DOCUMENT', `${nombre}: ese nombre pertenece a otro documento.`)
      const ultima = doc.versiones.map(item => item.version).sort((a, b) => peso(b) - peso(a))[0] ?? null
      const nueva = nuevaVersion(ultima)
      doc.versiones.push({ ...crearVersion(docId, nueva, { nombre, ruta: path.join('archivos', docId, `v${nueva}`, nombre), bytes: archivo.contenido.length, tipo: entrada.formato, sha256 }, identidadNueva, ahora), texto: resumenTexto(entrada) })
      const nuevaOp = this.nuevaOperacion(estado, 'reemplazo', doc, nueva, doc.versionActiva, operador)
      doc.operacionEnCurso = nuevaOp
      doc.actualizadoEn = ahora
      return { opId: nuevaOp, version: nueva }
    })
    await this.almacenarYProcesar(docId, version, nombre, archivo.contenido, opId, 'reemplazo', entrada, sha256)
    return { documento: this.registro.documento(docId)!, operacion: this.registro.operacion(opId)! }
  }

  // Reprocesa el archivo guardado de una carga que falló (por ejemplo, tras
  // configurar el índice o recuperar el servicio).
  async reintentar(docId: string, operador: string) {
    const doc = this.registro.documento(docId)
    this.exigirIndice(doc?.nombre ?? docId)
    const { opId, version } = await this.registro.mutar(estado => {
      const actual = estado.documentos.find(item => item.id === docId)
      if (!actual || actual.estado === 'retirado') throw new KdError('NOT_FOUND', 'El documento no existe o ya fue retirado.')
      if (actual.operacionEnCurso) throw new KdError('DOCUMENT_BUSY')
      if (actual.estado !== 'error' || actual.versionActiva) throw new KdError('INVALID_STATE', 'Solo se reintenta un documento cuya carga falló.')
      const ultima = actual.versiones[actual.versiones.length - 1]
      ultima.estado = 'procesando'
      ultima.error = null
      actual.estado = 'procesando'
      actual.error = null
      const nuevaOp = this.nuevaOperacion(estado, 'reintento', actual, ultima.version, null, operador)
      actual.operacionEnCurso = nuevaOp
      return { opId: nuevaOp, version: ultima.version }
    })
    this.encolar(() => this.procesar(docId, version, opId, 'reintento'))
    return { documento: this.registro.documento(docId)!, operacion: this.registro.operacion(opId)! }
  }

  // --- Procesamiento: lectura → fragmentación por secciones → embeddings → verificación

  private async procesar(docId: string, version: string, opId: string, tipo: TipoOperacion) {
    let enviados = false
    let publicada = false
    let anterior: string | null = null
    try {
      const doc = this.registro.documento(docId)!
      const datos = doc.versiones.find(item => item.version === version)!
      const contenido = await readFile(this.registro.rutaArchivo(datos.archivo.ruta))
      const registros = datos.archivo.tipo === 'json'
        ? await this.leerArticuloJson(docId, version, opId, datos, contenido)
        : await this.leerDocumentoTexto(docId, version, opId, datos, contenido)
      if (!registros) return
      enviados = true
      if (!await this.indexarYVerificar(docId, version, opId, datos, registros)) return

      anterior = await this.activar(docId, version, opId, registros.length)
      publicada = true
    } catch (error) {
      this.log.error({ err: (error as Error).name, docId }, 'fallo inesperado procesando documento')
      // Solo se deshace lo que todavía no se publicó. Una vez activa, la versión
      // nueva nunca se toca por un fallo posterior.
      if (!publicada) await this.fallar(docId, version, opId, 'interno', 'Error inesperado durante el procesamiento.', enviados)
      else await this.cerrarPublicada(docId, version, opId, tipo, false)
      return
    }

    // Después de publicar, retirar la versión anterior es de mejor esfuerzo: ya
    // no es servible y quedó marcada para limpieza en la misma activación.
    let limpia = true
    if (tipo === 'reemplazo' && anterior) {
      try {
        limpia = await this.retirarVersion(docId, anterior, opId)
      } catch (error) {
        limpia = false
        this.log.warn({ err: (error as Error).name, docId }, 'limpieza de la versión anterior pendiente')
        try {
          await this.paso(opId, 'limpieza', 'error', `v${anterior}: la limpieza quedó pendiente; no se usa en respuestas y se reintentará`)
        } catch { /* el registro también falla: la recuperación al reiniciar lo cerrará */ }
      }
    }
    await this.cerrarPublicada(docId, version, opId, tipo, limpia)
  }

  // Artículo JSON kb_article_v2: lectura del original guardado y fragmentación
  // por secciones. Devuelve null si la versión ya quedó fallida.
  private async leerArticuloJson(docId: string, version: string, opId: string, datos: Version, contenido: Buffer): Promise<RegistroIndice[] | null> {
    let articulo: Articulo
    try {
      articulo = validarArticulo(leerJson(datos.archivo.nombre, contenido)).articulo
    } catch (error) {
      await this.fallar(docId, version, opId, 'lectura', error instanceof KdError ? error.message : 'No se pudo leer el artículo.', false)
      return null
    }
    if (!contenidoUtil(articulo)) {
      await this.fallar(docId, version, opId, 'lectura', 'El artículo no tiene contenido indexable en "details": las secciones de kb_article_v2 están vacías o solo hay banderas, listas vacías o claves ajenas al esquema. No se indexa.', false)
      return null
    }
    await this.paso(opId, 'lectura', 'ok', `Artículo "${datos.articulo.titulo}" leído desde el JSON original`)

    const fragmentos = fragmentarArticulo(articulo)
    if (!fragmentos.length) {
      await this.fallar(docId, version, opId, 'fragmentacion', 'Las secciones del artículo no produjeron fragmentos con contenido.', false)
      return null
    }
    await this.registro.guardarFragmentos(docId, version, fragmentos)
    const porTipo = fragmentos.reduce<Record<string, number>>((cuenta, fragmento) => ({ ...cuenta, [fragmento.tipo]: (cuenta[fragmento.tipo] ?? 0) + 1 }), {})
    await this.paso(opId, 'fragmentacion', 'ok', `${fragmentos.length} fragmentos por sección (${REGLA_FRAGMENTACION}): ${Object.entries(porTipo).map(([clave, valor]) => `${clave} ${valor}`).join(', ')}`)
    return fragmentos.map(fragmento => registroDeFragmento(docId, datos, articulo, fragmento))
  }

  // PDF, DOCX y TXT: extracción del texto del ORIGINAL guardado, fragmentación
  // por bloques y clasificación. Devuelve null si la versión ya quedó fallida.
  private async leerDocumentoTexto(docId: string, version: string, opId: string, datos: Version, contenido: Buffer): Promise<RegistroIndice[] | null> {
    let texto: string
    try {
      texto = await extraerTexto(datos.archivo.nombre, datos.archivo.tipo as FormatoTexto, contenido)
    } catch (error) {
      await this.fallar(docId, version, opId, 'lectura', error instanceof KdError ? error.message : 'No se pudo extraer el texto.', false)
      return null
    }
    await this.registro.guardarTexto(docId, version, texto)
    await this.paso(opId, 'lectura', 'ok', `${texto.length} caracteres de texto extraídos del ${NOMBRE_FORMATO[datos.archivo.tipo]} original`)
    const { fragmentos, bloques } = fragmentarTexto(texto, datos.archivo.nombre)
    if (!fragmentos.length) {
      await this.fallar(docId, version, opId, 'fragmentacion', 'El texto no produjo fragmentos con contenido.', false)
      return null
    }
    await this.registro.guardarFragmentos(docId, version, fragmentos)
    const porTipo = fragmentos.reduce<Record<string, number>>((cuenta, fragmento) => ({ ...cuenta, [fragmento.tipo]: (cuenta[fragmento.tipo] ?? 0) + 1 }), {})
    await this.paso(opId, 'fragmentacion', 'ok', `${fragmentos.length} fragmentos de ${bloques} bloques (${REGLA_TEXTO})`)
    await this.paso(opId, 'clasificacion', 'ok', `Clasificación ${REGLA_CLASIFICACION}: ${Object.entries(porTipo).map(([clave, valor]) => `${clave} ${valor}`).join(', ')}`)
    return fragmentos.map(fragmento => registroDeTexto(docId, datos, fragmento))
  }

  // Embeddings y verificación, comunes a JSON y texto. Un upsert aceptado no
  // implica que el índice ya lo muestre: antes de publicar se exige ver TODOS
  // los IDs esperados y que la versión aparezca en búsquedas. Devuelve false si
  // la versión quedó fallida (con rollback de lo enviado).
  private async indexarYVerificar(docId: string, version: string, opId: string, datos: Version, registros: RegistroIndice[]): Promise<boolean> {
    if (!this.indice) {
      await this.fallar(docId, version, opId, 'embeddings', 'La integración con el índice no está configurada.', false)
      return false
    }
    // Restos con el mismo prefijo de versión (por ejemplo, de un registro efímero
    // perdido en un reinicio que reutiliza DOC-0001) se retiran antes: si no,
    // fragmentos ajenos quedarían publicados con esta versión.
    try {
      const { total, restantes } = await this.purgar(prefijoVersion(docId, version))
      if (restantes > 0) {
        await this.fallar(docId, version, opId, 'preparacion', `El índice conserva ${restantes} registros previos con el identificador de esta versión; no se indexa sobre ellos.`, false)
        return false
      }
      if (total > 0) await this.paso(opId, 'preparacion', 'ok', `${total} registros previos con el identificador de esta versión se retiraron del índice antes de indexar`)
      await this.indice.upsert(registros)
    } catch (error) {
      await this.fallar(docId, version, opId, 'embeddings', `No se pudieron generar o guardar los embeddings: ${(error as Error).message}`, true)
      return false
    }
    await this.paso(opId, 'embeddings', 'ok', `${registros.length} registros enviados a ${this.indice.descripcion}`)
    const esperados = registros.map(registro => registro.id)
    const listados = await this.listarHasta(prefijoVersion(docId, version), ids => esperados.every(id => ids.includes(id)))
    const presentes = esperados.filter(id => listados.includes(id)).length
    if (presentes < esperados.length) {
      await this.fallar(docId, version, opId, 'verificacion', `El índice solo confirma ${presentes} de ${esperados.length} embeddings.`, true)
      return false
    }
    const buscable = await this.esperarCondicion(() => this.indice!.esBuscable(datos.articleId, registros[0].texto))
    if (!buscable) {
      await this.fallar(docId, version, opId, 'verificacion', 'El índice aún no devuelve la versión en búsquedas.', true)
      return false
    }
    await this.paso(opId, 'verificacion', 'ok', `${esperados.length} de ${esperados.length} embeddings confirmados y buscables`)
    return true
  }

  private async cerrarPublicada(docId: string, version: string, opId: string, tipo: TipoOperacion, limpia: boolean) {
    const fragmentos = this.registro.documento(docId)?.versiones.find(item => item.version === version)?.fragmentos ?? 0
    const nota = limpia ? '' : ' La limpieza de la versión anterior quedó pendiente y se reintentará; sus fragmentos ya no se usan en respuestas.'
    try {
      await this.cerrar(opId, docId, 'exitoso', tipo === 'reemplazo'
        ? `La versión v${version} ya está activa. Las nuevas respuestas usarán solo esta versión.${nota}`
        : `Artículo indexado con ${fragmentos} fragmentos.`)
    } catch (error) {
      this.log.error({ err: (error as Error).name, docId }, 'no se pudo cerrar la operación publicada')
    }
  }

  private async esperarCondicion(condicion: () => Promise<boolean>): Promise<boolean> {
    const limite = Date.now() + this.opciones.verificacionIndiceMs
    for (;;) {
      if (await condicion()) return true
      if (Date.now() >= limite) return false
      await esperar(this.opciones.verificacionIntervaloMs)
    }
  }

  // Lista por prefijo hasta cumplir la condición o agotar la espera: Pinecone es
  // eventualmente consistente y un listado inmediato puede ir atrasado.
  private async listarHasta(prefijo: string, cumple: (ids: string[]) => boolean): Promise<string[]> {
    const limite = Date.now() + this.opciones.verificacionIndiceMs
    for (;;) {
      const ids = await this.indice!.listarIds(prefijo)
      if (cumple(ids) || Date.now() >= limite) return ids
      await esperar(this.opciones.verificacionIntervaloMs)
    }
  }

  // Borra del índice todo lo que tenga el prefijo y MIDE cuántos quedan. Además
  // del listado se borran los IDs conocidos: un registro que el índice aún no
  // lista (consistencia eventual) también debe retirarse.
  private async purgar(prefijo: string, conocidos: string[] = []): Promise<{ total: number; restantes: number }> {
    if (!this.indice) return { total: 0, restantes: 0 }
    const ids = [...new Set([...(await this.indice.listarIds(prefijo)), ...conocidos])]
    if (ids.length) {
      try {
        await this.indice.eliminar(ids)
      } catch (error) {
        this.log.warn({ err: (error as Error).name }, 'borrado parcial en el índice')
      }
    }
    const restantes = ids.length ? (await this.listarHasta(prefijo, quedan => quedan.length === 0)).length : 0
    return { total: ids.length, restantes }
  }

  private idsConocidos(docId: string, version: string, cantidad: number): string[] {
    return Array.from({ length: cantidad }, (_, posicion) => chunkId(docId, version, posicion + 1))
  }

  private async fallar(docId: string, version: string, opId: string, etapa: string, mensaje: string, rollback: boolean) {
    let residuales = 0
    if (rollback) {
      try {
        const enviados = (await this.registro.leerFragmentos(docId, version)).length
        residuales = (await this.purgar(prefijoVersion(docId, version), this.idsConocidos(docId, version, enviados))).restantes
      } catch {
        residuales = -1
      }
      await this.paso(opId, 'rollback', residuales === 0 ? 'ok' : 'error', residuales === 0
        ? `Los embeddings de v${version} se retiraron del índice; no se publicaron`
        : `No se pudo confirmar el retiro de los embeddings de v${version}; quedan excluidos de las respuestas y se reintentará la limpieza`)
    }
    await this.registro.eliminarFragmentos(docId, version)
    await this.paso(opId, etapa, 'error', mensaje)
    const doc = await this.registro.mutar(estado => {
      const actual = estado.documentos.find(item => item.id === docId)!
      const datos = actual.versiones.find(item => item.version === version)!
      datos.estado = 'fallida'
      datos.error = { etapa, mensaje }
      datos.embeddingsResiduales = residuales
      if (!actual.versionActiva) {
        actual.estado = 'error'
        actual.error = { etapa, mensaje }
      }
      actual.actualizadoEn = this.fecha()
      return structuredClone(actual)
    })
    const activa = doc.versiones.find(item => item.version === doc.versionActiva)
    const conserva = activa
      ? ` Se conserva la versión v${activa.version} con sus ${activa.fragmentos} fragmentos. Los fragmentos de la versión v${version} no se publicaron y no aparecerán en respuestas.`
      : ' El documento no quedó disponible para consultas.'
    await this.cerrar(opId, docId, 'fallido', `${mensaje}${conserva}`)
  }

  // Publicación atómica: una sola escritura del registro cambia la versión
  // activa. Antes de ella, la versión nueva no es servible; después, la
  // anterior deja de serlo.
  private async activar(docId: string, version: string, opId: string, fragmentos: number): Promise<string | null> {
    return this.registro.mutar(estado => {
      const doc = estado.documentos.find(item => item.id === docId)!
      const anterior = doc.versionActiva
      for (const datos of doc.versiones) {
        if (datos.version === version) {
          datos.estado = 'activa'
          datos.fragmentos = fragmentos
        } else if (datos.estado === 'activa') {
          // Queda marcada para limpieza en esta misma escritura: si el proceso
          // se corta antes de retirarla, la recuperación sabe que debe hacerlo.
          datos.estado = 'reemplazada'
          datos.embeddingsResiduales = -1
        }
      }
      doc.versionActiva = version
      doc.nombre = doc.versiones.find(item => item.version === version)!.archivo.nombre
      doc.estado = 'indexado'
      doc.error = null
      doc.actualizadoEn = this.fecha()
      estado.revision += 1
      const op = estado.operaciones.find(item => item.id === opId)!
      op.pasos.push({ nombre: 'activacion', estado: 'ok', detalle: `v${version} activa${anterior ? `; v${anterior} deja de sustentar respuestas` : ''}`, en: this.fecha() })
      op.contadores = { fragmentos: { hechos: fragmentos, total: fragmentos }, embeddings: { hechos: fragmentos, total: fragmentos }, registro: 'activo' }
      return anterior
    })
  }

  // Sustitución total: la versión anterior ya no es servible desde la
  // activación; aquí se retiran sus fragmentos y embeddings.
  private async retirarVersion(docId: string, version: string, opId: string): Promise<boolean> {
    const fragmentos = this.registro.documento(docId)?.versiones.find(item => item.version === version)?.fragmentos ?? 0
    await this.registro.eliminarFragmentos(docId, version)
    let restantes = -1
    try {
      restantes = (await this.purgar(prefijoVersion(docId, version), this.idsConocidos(docId, version, fragmentos))).restantes
    } catch {
      restantes = -1
    }
    await this.paso(opId, 'limpieza', restantes === 0 ? 'ok' : 'error', restantes === 0
      ? `v${version}: ${fragmentos} fragmentos y sus embeddings retirados`
      : `v${version}: quedan embeddings por retirar; no se usan en respuestas y se reintentará la limpieza`)
    await this.registro.mutar(estado => {
      const datos = estado.documentos.find(item => item.id === docId)!.versiones.find(item => item.version === version)!
      datos.embeddingsResiduales = restantes
    })
    return restantes === 0
  }

  private cerrar(opId: string, docId: string, resultado: Operacion['resultado'], mensaje: string) {
    return this.registro.mutar(estado => {
      const op = estado.operaciones.find(item => item.id === opId)!
      op.resultado = resultado
      op.fin = this.fecha()
      op.mensaje = mensaje
      const doc = estado.documentos.find(item => item.id === docId)
      if (doc && doc.operacionEnCurso === opId) doc.operacionEnCurso = null
    })
  }

  // --- Eliminación (HU09) -----------------------------------------------

  // Fragmentos que siguen en disco, MEDIDOS. Si una versión no se puede leer,
  // cuenta con lo que dice el registro: nunca se supone que no queda nada.
  private async fragmentosEnDisco(docId: string, versiones: Version[]): Promise<number> {
    let total = 0
    for (const version of versiones) {
      if (!existsSync(this.registro.rutaArchivo(path.join('fragmentos', docId, `v${version.version}.json`)))) continue
      try {
        total += (await this.registro.leerFragmentos(docId, version.version)).length
      } catch {
        total += Math.max(1, version.fragmentos)
      }
    }
    return total
  }

  async eliminar(docId: string, operador: string, confirmado: unknown): Promise<Operacion> {
    if (confirmado !== true) throw new KdError('CONFIRMATION_REQUIRED', 'Confirma que el documento está retirado antes de eliminarlo.')

    // Reserva y bloqueo en una sola mutación. Desde aquí el documento deja de
    // ser servible: ninguna consulta lo usa aunque el borrado tarde o falle.
    const { opId, doc } = await this.registro.mutar(estado => {
      const actual = estado.documentos.find(item => item.id === docId)
      if (!actual || actual.estado === 'retirado') throw new KdError('NOT_FOUND', 'El documento no existe o ya fue retirado.')
      if (actual.operacionEnCurso || actual.estado === 'procesando' || actual.estado === 'eliminando') throw new KdError('DOCUMENT_BUSY')
      const nuevaOp = this.nuevaOperacion(estado, 'eliminacion', actual, actual.versionActiva, null, operador)
      const previo = structuredClone(actual)
      actual.estado = 'eliminando'
      actual.operacionEnCurso = nuevaOp
      estado.revision += 1
      return { opId: nuevaOp, doc: previo }
    })
    const progreso: Progreso = { fragmentosTotal: null, embeddingsTotal: null, fragmentosRestantes: null, embeddingsRestantes: null }
    try {
      await this.paso(opId, 'confirmacion', 'ok', 'El operador confirmó que el documento está retirado')
      const versiones = doc.versiones.filter(item => item.estado !== 'retirada')
      // Se intenta borrar todo ID conocido de cualquier versión, pero el total
      // solo cuenta los que pueden seguir en el índice: la versión activa o en
      // proceso y las que tienen limpieza pendiente o desconocida. Una versión
      // reemplazada ya limpiada no infla el conteo.
      const conocidos = versiones.flatMap(version => this.idsConocidos(docId, version.version, version.fragmentos))
      const vigentes = versiones
        .filter(version => version.estado === 'activa' || version.estado === 'procesando' || version.embeddingsResiduales !== 0)
        .flatMap(version => this.idsConocidos(docId, version.version, version.fragmentos))

      // 1. Totales ANTES de borrar nada, desde el registro (que conoce los
      //    fragmentos publicados aunque el disco falle) y desde el índice si
      //    responde. Se persisten; un reintento nunca cuenta contra un total menor.
      const enRegistro = versiones.reduce((total, version) => total + (version.estado === 'activa' ? version.fragmentos : 0), 0)
      let enDisco = 0
      try { enDisco = await this.fragmentosEnDisco(docId, versiones) } catch { enDisco = 0 }
      let listados: number | null = null
      if (this.indice) {
        try { listados = new Set([...(await this.indice.listarIds(prefijoDocumento(docId))), ...vigentes]).size } catch { listados = null }
      }
      const estimadoIndice = vigentes.length
      progreso.fragmentosTotal = Math.max(doc.eliminacion?.fragmentosTotal ?? 0, enRegistro, enDisco)
      progreso.embeddingsTotal = Math.max(doc.eliminacion?.embeddingsTotal ?? 0, listados ?? estimadoIndice)
      await this.registro.mutar(estado => {
        estado.documentos.find(item => item.id === docId)!.eliminacion = { fragmentosTotal: progreso.fragmentosTotal!, embeddingsTotal: progreso.embeddingsTotal! }
      })
      const fragmentosTotal = progreso.fragmentosTotal
      const embeddingsTotal = progreso.embeddingsTotal

      // 2. Fragmentos: se borran y luego se MIDE lo que queda.
      for (const version of versiones) await this.registro.eliminarFragmentos(docId, version.version)
      const fragmentosRestantes = await this.fragmentosEnDisco(docId, versiones)
      progreso.fragmentosRestantes = fragmentosRestantes
      await this.paso(opId, 'fragmentos', fragmentosRestantes === 0 ? 'ok' : 'error', `${Math.max(0, fragmentosTotal - fragmentosRestantes)} de ${fragmentosTotal} fragmentos retirados`)

      // 3. Embeddings: lo que decide es lo que el índice sigue mostrando, nunca
      //    un total recortado. Sin índice o sin respuesta, lo pendiente es desconocido.
      let embeddingsRestantes: number | null = null
      if (!this.indice) {
        await this.paso(opId, 'embeddings', 'error', 'La integración con el índice no está configurada; no se pudieron retirar los embeddings')
      } else {
        try {
          embeddingsRestantes = (await this.purgar(prefijoDocumento(docId), conocidos)).restantes
        } catch (error) {
          embeddingsRestantes = null
          this.log.warn({ err: (error as Error).name }, 'el índice no respondió durante la eliminación')
        }
        await this.paso(opId, 'embeddings', embeddingsRestantes === 0 ? 'ok' : 'error', embeddingsRestantes === null
          ? `No se pudo confirmar cuántos de los ${embeddingsTotal} embeddings quedan en el índice`
          : `${Math.max(0, embeddingsTotal - embeddingsRestantes)} de ${embeddingsTotal} embeddings retirados del índice`)
      }
      progreso.embeddingsRestantes = embeddingsRestantes

      // 4. Registro: solo se retira si NO queda nada medido.
      const completo = fragmentosRestantes === 0 && embeddingsRestantes === 0
      const archivados: string[] = []
      if (completo) {
        for (const version of versiones) {
          try {
            const destino = await this.registro.archivarArchivo(version.archivo.ruta)
            if (destino) archivados.push(destino)
          } catch {
            this.log.warn({ docId }, 'no se pudo archivar un original retirado')
          }
        }
      }
      const embeddingsHechos = embeddingsRestantes === null ? 0 : Math.max(0, embeddingsTotal - embeddingsRestantes)
      await this.registro.mutar(estado => {
        const actual = estado.documentos.find(item => item.id === docId)!
        actual.actualizadoEn = this.fecha()
        if (completo) {
          actual.estado = 'retirado'
          actual.retiradoEn = this.fecha()
          actual.versionActiva = null
          for (const version of actual.versiones) {
            version.estado = 'retirada'
            version.embeddingsResiduales = 0
          }
        } else {
          actual.estado = 'bloqueado'
        }
        const op = estado.operaciones.find(item => item.id === opId)!
        op.contadores = {
          fragmentos: { hechos: Math.max(0, fragmentosTotal - fragmentosRestantes), total: fragmentosTotal },
          embeddings: { hechos: embeddingsHechos, total: embeddingsTotal },
          registro: completo ? 'retirado' : 'pendiente',
        }
        op.pasos.push({
          nombre: 'registro', estado: completo ? 'ok' : 'error', en: this.fecha(),
          detalle: completo ? `Documento retirado del registro; ${archivados.length} original(es) archivado(s)` : 'Registro pendiente hasta completar la eliminación',
        })
      })
      const quedan = (cantidad: number, singular: string, plural: string) => (cantidad === 1 ? `Queda 1 ${singular} asociado` : `Quedan ${cantidad} ${plural} asociados`)
      const pendiente = embeddingsRestantes === null
        ? `No se pudo confirmar el retiro de los embeddings de este documento`
        : embeddingsRestantes > 0
          ? `${quedan(embeddingsRestantes, 'embedding', 'embeddings')} a este documento`
          : `${quedan(fragmentosRestantes, 'fragmento', 'fragmentos')} a este documento`
      await this.cerrar(opId, docId, completo ? 'exitoso' : 'fallido_parcial', completo
        ? 'Ya no aparecerá como fuente ni se usará como contexto en nuevas consultas.'
        : `No se puede eliminar por completo. ${pendiente}. La operación no se registra como exitosa.`)
    } catch (error) {
      this.log.error({ err: (error as Error).name, docId }, 'la eliminación se interrumpió')
      await this.cerrarEliminacionInterrumpida(docId, opId, progreso)
    }
    return this.registro.operacion(opId)!
  }

  // Un error inesperado a mitad de la eliminación no deja la operación "en
  // curso" ni el documento reservado: se cierra como parcial, sigue bloqueado
  // para consultas y el operador puede reintentar. Lo desconocido no se
  // persiste como 0: solo se guardan totales realmente calculados.
  private async cerrarEliminacionInterrumpida(docId: string, opId: string, progreso: Progreso) {
    try {
      await this.registro.mutar(estado => {
        const actual = estado.documentos.find(item => item.id === docId)!
        actual.estado = 'bloqueado'
        if (actual.operacionEnCurso === opId) actual.operacionEnCurso = null
        if (progreso.fragmentosTotal !== null && progreso.embeddingsTotal !== null) {
          actual.eliminacion = { fragmentosTotal: progreso.fragmentosTotal, embeddingsTotal: progreso.embeddingsTotal }
        }
        actual.actualizadoEn = this.fecha()
        const op = estado.operaciones.find(item => item.id === opId)!
        const contador = (total: number | null, restantes: number | null) => ({ hechos: total === null || restantes === null ? 0 : Math.max(0, total - restantes), total: total ?? 0 })
        op.contadores = {
          fragmentos: contador(progreso.fragmentosTotal, progreso.fragmentosRestantes),
          embeddings: contador(progreso.embeddingsTotal, progreso.embeddingsRestantes),
          registro: 'pendiente',
        }
        op.pasos.push({ nombre: 'interrupcion', estado: 'error', detalle: 'Error inesperado del servidor durante la eliminación', en: this.fecha() })
        op.resultado = 'fallido_parcial'
        op.fin = this.fecha()
        op.mensaje = 'La eliminación se interrumpió por un error inesperado. El documento queda bloqueado para consultas hasta completarla; reintenta.'
      })
    } catch (error) {
      // Si tampoco se puede escribir el registro, al reiniciar se cierra igual.
      this.log.error({ err: (error as Error).name, docId }, 'no se pudo registrar la interrupción de la eliminación')
    }
  }

  // --- Recuperación y limpieza ------------------------------------------

  // Tras un reinicio, nada queda "Procesando" para siempre: la operación
  // interrumpida se cierra como fallida y sus embeddings se marcan para limpiar.
  async recuperar() {
    const interrumpidas = this.registro.documentos().filter(doc => doc.operacionEnCurso || doc.estado === 'procesando' || doc.estado === 'eliminando')
    for (const doc of interrumpidas) {
      const opId = doc.operacionEnCurso
      await this.registro.mutar(estado => {
        const actual = estado.documentos.find(item => item.id === doc.id)!
        for (const version of actual.versiones) {
          if (version.estado === 'procesando') {
            version.estado = 'fallida'
            version.error = { etapa: 'interrumpido', mensaje: 'El procesamiento se interrumpió por un reinicio del servidor.' }
            version.embeddingsResiduales = -1
          }
        }
        if (actual.estado === 'eliminando') actual.estado = 'bloqueado'
        else if (actual.estado === 'procesando') {
          actual.estado = actual.versionActiva ? 'indexado' : 'error'
          if (!actual.versionActiva) actual.error = { etapa: 'interrumpido', mensaje: 'El procesamiento se interrumpió por un reinicio del servidor. Reintenta la carga.' }
        }
        actual.operacionEnCurso = null
        const op = estado.operaciones.find(item => item.id === opId)
        if (op && op.resultado === 'en_curso') {
          // Si la versión ya se había publicado, la operación cumplió su objetivo;
          // lo que faltara (limpieza) queda marcado como residuo.
          const publicada = op.tipo !== 'eliminacion' && op.version !== null && op.version === actual.versionActiva
          op.resultado = publicada ? 'exitoso' : op.tipo === 'eliminacion' ? 'fallido_parcial' : 'fallido'
          op.fin = this.fecha()
          op.mensaje = publicada
            ? `La versión v${op.version} quedó activa; la operación se interrumpió por un reinicio antes de terminar la limpieza.`
            : 'La operación se interrumpió por un reinicio del servidor.'
        }
        estado.revision += 1
      })
    }
    this.solicitarLimpieza()
  }

  // Retira fragmentos y embeddings de versiones que ya no pueden sustentar
  // respuestas (fallidas, reemplazadas, interrumpidas). Se ejecuta al arrancar,
  // tras cada operación y de forma periódica mientras queden residuos.
  async limpiarResiduos(): Promise<number> {
    if (!this.indice) return this.residuosPendientes()
    for (const doc of this.registro.documentos()) {
      if (doc.operacionEnCurso || doc.estado === 'eliminando') continue
      for (const version of doc.versiones) {
        if (version.embeddingsResiduales === 0 || version.estado === 'activa' || version.estado === 'procesando') continue
        try {
          await this.registro.eliminarFragmentos(doc.id, version.version)
          const { restantes } = await this.purgar(prefijoVersion(doc.id, version.version), this.idsConocidos(doc.id, version.version, version.fragmentos))
          await this.registro.mutar(estado => {
            const datos = estado.documentos.find(item => item.id === doc.id)?.versiones.find(item => item.version === version.version)
            if (datos) datos.embeddingsResiduales = restantes
          })
        } catch {
          this.log.warn({ docId: doc.id }, 'la limpieza de residuos sigue pendiente')
        }
      }
    }
    return this.residuosPendientes()
  }

  residuosPendientes(): number {
    return this.registro.documentos().reduce((total, doc) => total + doc.versiones.filter(version => version.estado !== 'activa' && version.estado !== 'procesando' && version.embeddingsResiduales !== 0).length, 0)
  }

  // Mientras queden residuos se reintenta su limpieza cada cierto tiempo. En
  // modo forusguide la recuperación ocurre fuera y no puede filtrar versiones
  // no servibles antes de su topK: cuanto antes desaparezcan, mejor.
  iniciarLimpiezaPeriodica(intervaloMs: number): () => void {
    const temporizador = setInterval(() => {
      if (this.residuosPendientes() > 0) this.encolar(async () => { await this.limpiarResiduos() })
    }, intervaloMs)
    temporizador.unref()
    return () => clearInterval(temporizador)
  }

  solicitarLimpieza() {
    this.encolar(async () => { await this.limpiarResiduos() })
  }
}
