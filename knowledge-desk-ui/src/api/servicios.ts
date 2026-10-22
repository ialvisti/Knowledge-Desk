import { pedir } from './cliente'
import type { ArticuloExterno, ContratoConsulta, DetalleDocumento, DocumentoResumen, Ejemplos, EstadoServidor, Operacion } from './tipos'

export const MIN_PREGUNTA = 10
export const MAX_PREGUNTA = 2000
export const MAX_ARCHIVO = 50 * 1024 * 1024
// Knowledge Desk administra artículos de conocimiento kb_article_v2: JSON puro.
export const FORMATOS = ['json'] as const

export const obtenerEstado = () => pedir<EstadoServidor>('/api/estado')
export const obtenerEjemplos = () => pedir<Ejemplos>('/api/ejemplos')

// Solo viaja la pregunta: cada consulta es independiente, sin historial.
export const consultar = (question: string, requestId: string, timeoutMs: number, signal?: AbortSignal) =>
  pedir<ContratoConsulta>('/api/consulta', { json: { question }, requestId, timeoutMs, signal })

export const listarDocumentos = () => pedir<{ documentos: DocumentoResumen[]; indexacionConfigurada: boolean; revisionCorpus: number }>('/api/documentos')
export const detalleDocumento = (id: string, version?: string | null) =>
  pedir<DetalleDocumento>(`/api/documentos/${encodeURIComponent(id)}${version ? `?version=${encodeURIComponent(version)}` : ''}`)
export const obtenerFuente = (articleId: string) => pedir<ArticuloExterno | { tipo: 'documento'; documentoId: string; version: string }>(`/api/fuentes/${encodeURIComponent(articleId)}`)

function formulario(archivo: File) {
  const datos = new FormData()
  datos.append('archivo', archivo, archivo.name)
  return datos
}

export const cargarDocumento = (archivo: File) =>
  pedir<{ documento: DocumentoResumen; operacion: Operacion }>('/api/documentos', { formData: formulario(archivo) })
export const reemplazarDocumento = (id: string, archivo: File) =>
  pedir<{ documento: DocumentoResumen; operacion: Operacion }>(`/api/documentos/${encodeURIComponent(id)}/reemplazo`, { formData: formulario(archivo) })
export const reintentarDocumento = (id: string) =>
  pedir<{ documento: DocumentoResumen; operacion: Operacion }>(`/api/documentos/${encodeURIComponent(id)}/reintento`, { method: 'POST', json: {} })
export const eliminarDocumento = (id: string) =>
  pedir<{ operacion: Operacion }>(`/api/documentos/${encodeURIComponent(id)}/eliminacion`, { json: { confirmado: true } })
export const obtenerOperacion = (id: string) => pedir<{ operacion: Operacion }>(`/api/operaciones/${encodeURIComponent(id)}`)

export function validarPregunta(pregunta: string): string | null {
  const valor = pregunta.trim()
  if (!valor) return 'Escribe una pregunta para consultar.'
  return null
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024)

// Validación previa en el navegador para avisar al instante. El servidor vuelve
// a validar el archivo y el esquema del artículo: esta comprobación no sustituye
// a la suya.
export function validarArchivo(archivo: Pick<File, 'name' | 'size'>, maxBytes = MAX_ARCHIVO): string | null {
  const extension = archivo.name.includes('.') ? archivo.name.slice(archivo.name.lastIndexOf('.') + 1).toLowerCase() : ''
  if (!(FORMATOS as readonly string[]).includes(extension)) return `${archivo.name}: formato no admitido. Carga un artículo de conocimiento en JSON (.json).`
  if (archivo.size === 0) return `${archivo.name}: el archivo está vacío.`
  if (archivo.size > maxBytes) return `${archivo.name}: supera el límite de ${mb(maxBytes)} MB.`
  return null
}

export const textoLimite = (maxBytes = MAX_ARCHIVO) => `JSON (Max ${mb(maxBytes)}MB)`
