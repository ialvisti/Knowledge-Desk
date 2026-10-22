import { parentPort, workerData } from 'node:worker_threads'
import type { Articulo } from '../../src/documents/articulo.ts'
import { fragmentarArticulo } from '../../src/documents/chunker.ts'

// Ejecuta el chunker en un hilo aparte: si entrara en un bucle sin fin, la
// prueba puede terminar el hilo en vez de quedarse bloqueada.
parentPort!.postMessage(fragmentarArticulo(workerData as Articulo))
