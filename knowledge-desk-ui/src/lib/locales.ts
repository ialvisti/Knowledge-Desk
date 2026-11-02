import type { DocumentoLocal, TipoLocal } from '../local/documentos'
import { fechaTexto, plural, tamano } from './formato'

// Rutas y textos de la colección local del navegador.
export const RUTA_COLECCION_LOCAL = '/documentos?coleccion=local'
export const ACEPTA_LOCAL = '.pdf,.docx,.txt,.json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,application/json'
export const ETIQUETA_TIPO: Record<TipoLocal, string> = { pdf: 'PDF', docx: 'DOCX', txt: 'TXT', json: 'JSON' }
export const ICONO_TIPO: Record<TipoLocal, string> = { pdf: 'picture_as_pdf', docx: 'article', txt: 'description', json: 'data_object' }

export const rutaDocumentoLocal = (id: string) => `/documentos/local/${encodeURIComponent(id)}`

export function tipoDe(nombre: string): TipoLocal | null {
  const extension = nombre.slice(nombre.lastIndexOf('.') + 1).toLowerCase()
  return extension in ETIQUETA_TIPO ? extension as TipoLocal : null
}

export function describirLocal(documento: DocumentoLocal): string {
  return `${ETIQUETA_TIPO[documento.tipo]} · v${documento.version} · ${tamano(documento.bytes)} · cargado el ${fechaTexto(documento.fechaCarga)} · ${plural(documento.fragmentos.length, 'fragmento', 'fragmentos')}`
}
