import { pedir } from './cliente'
import type { ArticuloExterno, ContratoConsulta, DetalleDocumento, DocumentoResumen, Ejemplos, EstadoServidor, Operacion } from './tipos'

// Los mismos límites que valida el servidor (knowledge-desk-server/src/consulta/validate.ts).
export const MIN_PREGUNTA = 10
export const MAX_PREGUNTA = 100
export const MAX_ARCHIVO = 50 * 1024 * 1024
// Formatos por defecto. El servidor declara los suyos en /api/estado
// (limites.formatos): artículos JSON kb_article_v2 y, si los admite, PDF, DOCX y TXT.
export const FORMATOS = ['json'] as const

const extensionDe = (nombre: string) => (nombre.includes('.') ? nombre.slice(nombre.lastIndexOf('.') + 1).toLowerCase() : '')
const soloJson = (formatos: readonly string[]) => formatos.length === 1 && formatos[0] === 'json'
export const aceptarFormatos = (formatos: readonly string[]) => formatos.map(formato => (formato === 'json' ? '.json,application/json' : `.${formato}`)).join(',')

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

export type MotivoPregunta = 'vacia' | 'corta' | 'larga'

// Misma regla que el servidor (validate.ts): se ignoran los espacios de los
// extremos y se cuentan puntos de código, no unidades UTF-16. Así un emoji
// cuenta como un carácter en los dos lados.
export const largoPregunta = (pregunta: string) => Array.from(pregunta.trim()).length

export function motivoPregunta(pregunta: string): MotivoPregunta | null {
  const largo = largoPregunta(pregunta)
  if (!largo) return 'vacia'
  if (largo < MIN_PREGUNTA) return 'corta'
  if (largo > MAX_PREGUNTA) return 'larga'
  return null
}

export function mensajePregunta(motivo: MotivoPregunta, largo: number): string {
  if (motivo === 'vacia') return 'Escribe una pregunta para consultar.'
  if (motivo === 'corta') return `La pregunta necesita al menos ${MIN_PREGUNTA} caracteres; tiene ${largo}.`
  return `La pregunta tiene ${largo} caracteres y el máximo es ${MAX_PREGUNTA}. Acórtala para consultar.`
}

// Validación previa en el navegador: una pregunta fuera de rango no se envía.
// El servidor vuelve a validarla antes de llamar a ningún servicio.
export function validarPregunta(pregunta: string): string | null {
  const motivo = motivoPregunta(pregunta)
  return motivo ? mensajePregunta(motivo, largoPregunta(pregunta)) : null
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024)

// Validación previa en el navegador para avisar al instante. El servidor vuelve
// a validar el archivo y el esquema del artículo: esta comprobación no sustituye
// a la suya.
export function validarArchivo(archivo: Pick<File, 'name' | 'size'>, maxBytes = MAX_ARCHIVO, formatos: readonly string[] = FORMATOS): string | null {
  if (!formatos.includes(extensionDe(archivo.name))) {
    return soloJson(formatos)
      ? `${archivo.name}: formato no admitido. Carga un artículo de conocimiento en JSON (.json).`
      : `${archivo.name}: formato no admitido. Formatos admitidos: artículo JSON (kb_article_v2), PDF con texto, DOCX y TXT.`
  }
  if (archivo.size === 0) return `${archivo.name}: el archivo está vacío.`
  if (archivo.size > maxBytes) return `${archivo.name}: supera el límite de ${mb(maxBytes)} MB.`
  return null
}

export const textoLimite = (maxBytes = MAX_ARCHIVO, formatos: readonly string[] = FORMATOS) => `${formatos.map(formato => formato.toUpperCase()).join(', ')} (Max ${mb(maxBytes)}MB)`
