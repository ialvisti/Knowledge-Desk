import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ProveedorError, type Proveedor } from '../providers/openaiCompatible.ts'
import { IndiceError, type Coincidencia, type IndiceCorpus, type OpcionesBusqueda, type RegistroIndice } from './types.ts'

interface Guardado { id: string; vector: number[]; metadata: Record<string, unknown> }
interface ArchivoArticulo { modelo: string; registros: Guardado[] }

export interface IndiceLocal extends IndiceCorpus {
  buscarVectores(vectores: number[][], topK: number, admitido: (articleId: string) => boolean): Promise<Coincidencia[][]>
}

function coseno(a: number[], b: number[]): number {
  let producto = 0
  let normaA = 0
  let normaB = 0
  for (let i = 0; i < a.length; i++) {
    producto += a[i] * b[i]
    normaA += a[i] * a[i]
    normaB += b[i] * b[i]
  }
  return normaA && normaB ? producto / Math.sqrt(normaA * normaB) : 0
}

function articuloDe(id: string): string {
  const posicion = id.lastIndexOf('_chunk_')
  return posicion === -1 ? id : id.slice(0, posicion)
}

const SEGURO = /^[A-Za-z0-9_.-]{1,200}$/

function cancelado(signal?: AbortSignal) {
  if (signal?.aborted) throw new IndiceError('cancelado', 'Operación cancelada')
}

// Índice vectorial del modo local. Los vectores los genera el proveedor de
// embeddings configurado; la búsqueda es por similitud coseno, no por palabras.
// Cada versión de documento vive en su propio archivo, así borrar una versión no
// reescribe las demás.
export function crearIndiceLocal(dir: string, proveedor: Proveedor): IndiceLocal {
  const carpeta = path.join(dir, 'indice-local')
  const cache = new Map<string, ArchivoArticulo>()
  let cargado = false

  async function asegurar() {
    if (cargado) return
    await mkdir(carpeta, { recursive: true })
    for (const nombre of await readdir(carpeta)) {
      if (!nombre.endsWith('.json')) continue
      try {
        cache.set(nombre.slice(0, -5), JSON.parse(await readFile(path.join(carpeta, nombre), 'utf8')) as ArchivoArticulo)
      } catch {
        throw new IndiceError('no_disponible', 'El índice local está dañado')
      }
    }
    cargado = true
  }

  async function escribir(articulo: string, datos: ArchivoArticulo | null) {
    if (!SEGURO.test(articulo)) throw new IndiceError('solicitud', 'Identificador de artículo no válido')
    const ruta = path.join(carpeta, `${articulo}.json`)
    if (!datos || !datos.registros.length) {
      await rm(ruta, { force: true })
      cache.delete(articulo)
      return
    }
    const temporal = `${ruta}.tmp`
    await writeFile(temporal, JSON.stringify(datos), 'utf8')
    await rename(temporal, ruta)
    cache.set(articulo, datos)
  }

  async function vectorizar(textos: string[], signal?: AbortSignal): Promise<number[][]> {
    try {
      return await proveedor.embeddings(textos, signal)
    } catch (error) {
      if (signal?.aborted) throw new IndiceError('cancelado', 'Operación cancelada')
      const detalle = error instanceof ProveedorError ? error.message : 'error desconocido'
      throw new IndiceError('embeddings', `No se pudieron generar los embeddings: ${detalle}`)
    }
  }

  function dimensionDelCorpus(): number | null {
    for (const datos of cache.values()) {
      if (datos.modelo === proveedor.modeloEmbeddings && datos.registros.length) return datos.registros[0].vector.length
    }
    return null
  }

  const indice: IndiceLocal = {
    tipo: 'local',
    descripcion: `Índice local · embeddings ${proveedor.modeloEmbeddings}`,

    async upsert(registros: RegistroIndice[], signal?: AbortSignal) {
      await asegurar()
      cancelado(signal)
      const vectores = await vectorizar(registros.map(registro => registro.texto), signal)
      const dimension = dimensionDelCorpus()
      if (dimension !== null && vectores.some(vector => vector.length !== dimension)) {
        throw new IndiceError('embeddings', 'La dimensión de los embeddings no coincide con la del índice; reindexa el corpus con el mismo modelo')
      }
      cancelado(signal)
      const porArticulo = new Map<string, Guardado[]>()
      registros.forEach((registro, posicion) => {
        const articulo = articuloDe(registro.id)
        const lista = porArticulo.get(articulo) ?? []
        lista.push({ id: registro.id, vector: vectores[posicion], metadata: { ...registro.metadata, content: registro.texto } })
        porArticulo.set(articulo, lista)
      })
      for (const [articulo, nuevos] of porArticulo) {
        const actual = cache.get(articulo)
        const conservados = actual && actual.modelo === proveedor.modeloEmbeddings
          ? actual.registros.filter(registro => !nuevos.some(nuevo => nuevo.id === registro.id))
          : []
        await escribir(articulo, { modelo: proveedor.modeloEmbeddings, registros: [...conservados, ...nuevos] })
      }
    },

    async listarIds(prefijo: string, signal?: AbortSignal) {
      await asegurar()
      cancelado(signal)
      const ids: string[] = []
      for (const datos of cache.values()) for (const registro of datos.registros) if (registro.id.startsWith(prefijo)) ids.push(registro.id)
      return ids
    },

    async eliminar(ids: string[], signal?: AbortSignal) {
      await asegurar()
      cancelado(signal)
      const porArticulo = new Map<string, Set<string>>()
      for (const id of ids) {
        const articulo = articuloDe(id)
        porArticulo.set(articulo, (porArticulo.get(articulo) ?? new Set()).add(id))
      }
      for (const [articulo, borrar] of porArticulo) {
        const actual = cache.get(articulo)
        if (!actual) continue
        await escribir(articulo, { ...actual, registros: actual.registros.filter(registro => !borrar.has(registro.id)) })
      }
    },

    async buscar(texto: string, topK: number, opciones: OpcionesBusqueda = {}) {
      const [vector] = await vectorizar([texto], opciones.signal)
      const excluidos = new Set(opciones.excluirArticulos ?? [])
      return (await indice.buscarVectores([vector], topK, articulo => !excluidos.has(articulo)))[0]
    },

    async esBuscable(articleId: string) {
      await asegurar()
      return Boolean(cache.get(articleId)?.registros.length)
    },

    async buscarVectores(vectores, topK, admitido) {
      await asegurar()
      return vectores.map(vector => {
        const coincidencias: Coincidencia[] = []
        for (const [articulo, datos] of cache) {
          // El filtro se aplica antes del corte topK: una versión no servible
          // nunca desplaza a una servible. Vectores de otro modelo no son
          // comparables y se ignoran hasta reindexar.
          if (datos.modelo !== proveedor.modeloEmbeddings || !admitido(articulo)) continue
          for (const registro of datos.registros) {
            if (registro.vector.length !== vector.length) continue
            coincidencias.push({ id: registro.id, score: coseno(vector, registro.vector), metadata: registro.metadata })
          }
        }
        return coincidencias.sort((a, b) => b.score - a.score).slice(0, topK)
      })
    },
  }
  return indice
}
