import { mkdir, readFile, rename, rm, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { articleId as calcularArticleId } from '../ids.ts'
import type { Fragmento } from './chunker.ts'

export type EstadoDocumento = 'procesando' | 'indexado' | 'error' | 'eliminando' | 'bloqueado' | 'retirado'
export type EstadoVersion = 'procesando' | 'activa' | 'fallida' | 'reemplazada' | 'retirada'

export interface FalloEtapa { etapa: string; mensaje: string }

// Identidad del artículo de conocimiento según su propio JSON. Es distinta del
// identificador interno de la versión (articleId "kd_…"), que aísla versiones en
// el índice sin tocar el metadata.article_id del original.
export interface IdentidadArticulo {
  id: string
  titulo: string
  recordKeeper: string | null
  planType: string | null
  schemaVersion: string | null
  avisos: string[]
}

export interface Version {
  version: string
  articleId: string
  archivo: { nombre: string; ruta: string; bytes: number; tipo: 'json'; sha256: string }
  articulo: IdentidadArticulo
  cargadoEn: string
  estado: EstadoVersion
  fragmentos: number
  // Embeddings que quedaron en el índice tras un rollback o una limpieza
  // fallida. Nunca se sirven: solo la versión activa de un documento indexado
  // puede sustentar respuestas.
  embeddingsResiduales: number
  error: FalloEtapa | null
}

export interface Documento {
  id: string
  nombre: string
  estado: EstadoDocumento
  versionActiva: string | null
  versiones: Version[]
  error: FalloEtapa | null
  operacionEnCurso: string | null
  eliminacion: { fragmentosTotal: number; embeddingsTotal: number } | null
  creadoEn: string
  actualizadoEn: string
  retiradoEn: string | null
}

export type TipoOperacion = 'carga' | 'reemplazo' | 'reintento' | 'eliminacion'
export type ResultadoOperacion = 'en_curso' | 'exitoso' | 'fallido' | 'fallido_parcial'

export interface PasoOperacion { nombre: string; estado: 'ok' | 'error' | 'omitido'; detalle: string; en: string }

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
  resultado: ResultadoOperacion
  mensaje: string | null
  contadores: {
    fragmentos?: { hechos: number; total: number }
    embeddings?: { hechos: number; total: number }
    registro?: 'retirado' | 'pendiente' | 'activo'
  }
  pasos: PasoOperacion[]
}

interface Estado {
  formato: 1
  secuencias: { documento: number; operacion: number }
  // Sube cada vez que cambia lo que puede sustentar respuestas. Invalida, por
  // ejemplo, la verificación de las preguntas de ejemplo.
  revision: number
  documentos: Documento[]
  operaciones: Operacion[]
}

const VACIO: Estado = { formato: 1, secuencias: { documento: 0, operacion: 0 }, revision: 0, documentos: [], operaciones: [] }

async function conReintento<T>(accion: () => Promise<T>): Promise<T> {
  // OneDrive y los antivirus bloquean archivos un instante después de
  // escribirlos; un renombrado puede fallar con EPERM/EBUSY y salir bien poco después.
  for (let intento = 0; ; intento++) {
    try {
      return await accion()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (intento >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
      await new Promise(resolve => setTimeout(resolve, 50 * (intento + 1)))
    }
  }
}

export class Registro {
  readonly dir: string
  private estado: Estado = structuredClone(VACIO)
  private cola: Promise<unknown> = Promise.resolve()

  constructor(dataDir: string) {
    this.dir = dataDir
  }

  private get archivoEstado() { return path.join(this.dir, 'registro.json') }

  async cargar() {
    await mkdir(this.dir, { recursive: true })
    if (existsSync(this.archivoEstado)) {
      this.estado = JSON.parse(await readFile(this.archivoEstado, 'utf8')) as Estado
    }
  }

  // Las mutaciones se encadenan: dos operaciones simultáneas nunca escriben el
  // registro a la vez ni pisan el cambio de la otra.
  mutar<T>(cambio: (estado: Estado) => T): Promise<T> {
    const tarea = this.cola.then(async () => {
      const copia = structuredClone(this.estado)
      const resultado = cambio(copia)
      await this.persistir(copia)
      this.estado = copia
      return resultado
    })
    this.cola = tarea.catch(() => undefined)
    return tarea
  }

  private async persistir(estado: Estado) {
    const temporal = `${this.archivoEstado}.${process.pid}.tmp`
    await writeFile(temporal, JSON.stringify(estado, null, 2), 'utf8')
    await conReintento(() => rename(temporal, this.archivoEstado))
  }

  get revision() { return this.estado.revision }

  documentos(): Documento[] { return structuredClone(this.estado.documentos) }

  documento(id: string): Documento | null {
    const doc = this.estado.documentos.find(item => item.id === id)
    return doc ? structuredClone(doc) : null
  }

  operacion(id: string): Operacion | null {
    const op = this.estado.operaciones.find(item => item.id === id)
    return op ? structuredClone(op) : null
  }

  operacionesDe(documentoId: string): Operacion[] {
    return structuredClone(this.estado.operaciones.filter(op => op.documentoId === documentoId))
  }

  // Un article_id "kd_" solo puede sustentar respuestas si es la versión activa
  // de un documento en estado Indexado (HU07, HU08, HU09).
  articuloServible(id: string): boolean {
    for (const doc of this.estado.documentos) {
      const version = doc.versiones.find(item => item.articleId === id)
      if (version) return doc.estado === 'indexado' && version.estado === 'activa' && doc.versionActiva === version.version
    }
    return false
  }

  ubicarArticulo(id: string): { documento: Documento; version: Version } | null {
    for (const doc of this.estado.documentos) {
      const version = doc.versiones.find(item => item.articleId === id)
      if (version) return structuredClone({ documento: doc, version })
    }
    return null
  }

  // Versiones "kd_" que existen en el registro pero no pueden sustentar
  // respuestas. Sirven para excluirlas de una búsqueda antes del corte topK.
  articulosNoServibles(): string[] {
    return this.estado.documentos.flatMap(doc => doc.versiones
      .filter(version => !(doc.estado === 'indexado' && version.estado === 'activa' && doc.versionActiva === version.version))
      .map(version => version.articleId))
  }

  // --- Archivos y fragmentos -------------------------------------------------

  // Toda ruta se resuelve dentro del directorio de datos. Nada que venga del
  // cliente se usa como ruta y, aun así, se rechaza cualquier salida del árbol.
  rutaArchivo(relativa: string) {
    const absoluta = path.resolve(this.dir, relativa)
    const raiz = path.resolve(this.dir) + path.sep
    if (path.isAbsolute(relativa) || !absoluta.startsWith(raiz)) throw new Error('Ruta fuera del directorio de datos')
    return absoluta
  }

  async guardarArchivo(docId: string, version: string, nombre: string, contenido: Buffer): Promise<string> {
    validarIdentidad(docId, version)
    const relativa = path.join('archivos', docId, `v${version}`, nombre)
    await mkdir(path.dirname(this.rutaArchivo(relativa)), { recursive: true })
    await writeFile(this.rutaArchivo(relativa), contenido)
    return relativa
  }

  // Política de retención: el original de un documento retirado se conserva
  // fuera del árbol activo para auditoría y recuperación manual. Es idempotente:
  // si un intento anterior ya lo movió, reintentar no bloquea la eliminación.
  async archivarArchivo(relativa: string): Promise<string | null> {
    const destino = path.join('archivo-retirados', relativa.replace(/^archivos[\\/]/, ''))
    const origen = this.rutaArchivo(relativa)
    const archivado = this.rutaArchivo(destino)
    if (!existsSync(origen)) return existsSync(archivado) ? destino : null
    await mkdir(path.dirname(archivado), { recursive: true })
    await conReintento(() => copyFile(origen, archivado))
    await conReintento(() => rm(origen, { force: true }))
    return destino
  }

  private rutaFragmentos(docId: string, version: string) {
    validarIdentidad(docId, version)
    return path.join(this.dir, 'fragmentos', docId, `v${version}.json`)
  }

  async guardarFragmentos(docId: string, version: string, fragmentos: Fragmento[]) {
    const ruta = this.rutaFragmentos(docId, version)
    await mkdir(path.dirname(ruta), { recursive: true })
    await writeFile(ruta, JSON.stringify(fragmentos), 'utf8')
  }

  async leerFragmentos(docId: string, version: string): Promise<Fragmento[]> {
    const ruta = this.rutaFragmentos(docId, version)
    if (!existsSync(ruta)) return []
    return JSON.parse(await readFile(ruta, 'utf8')) as Fragmento[]
  }

  async eliminarFragmentos(docId: string, version: string): Promise<number> {
    const fragmentos = await this.leerFragmentos(docId, version)
    await conReintento(() => rm(this.rutaFragmentos(docId, version), { force: true }))
    return fragmentos.length
  }
}

export const PATRON_DOCUMENTO = /^DOC-\d{4,6}$/
export const PATRON_VERSION = /^\d{1,4}\.\d{1,4}$/

function validarIdentidad(docId: string, version: string) {
  if (!PATRON_DOCUMENTO.test(docId) || !PATRON_VERSION.test(version)) throw new Error('Identificador de documento o versión no válido')
}

export function nuevaVersion(anterior: string | null): string {
  if (!anterior) return '1.0'
  const [mayor, menor] = anterior.split('.').map(Number)
  return `${mayor}.${menor + 1}`
}

export function crearVersion(docId: string, version: string, archivo: Version['archivo'], articulo: IdentidadArticulo, ahora: string): Version {
  return {
    version,
    articleId: calcularArticleId(docId, version),
    archivo,
    articulo,
    cargadoEn: ahora,
    estado: 'procesando',
    fragmentos: 0,
    embeddingsResiduales: 0,
    error: null,
  }
}
