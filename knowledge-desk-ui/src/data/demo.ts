import type { KnowledgeDocument } from '../types'

// Datos de la pantalla Documentos, que sigue siendo una maqueta: la ingesta real
// se hace fuera de la interfaz y no pasa por este formulario.
export const initialDocuments: KnowledgeDocument[] = [
  { id: 'privacy', name: 'Politica_Privacidad_2023.pdf', uploadedAt: '2023-10-12', fragments: 42, status: 'indexed' },
  { id: 'operations', name: 'Manual_Operaciones_V2.docx', uploadedAt: '2023-10-15', fragments: 156, status: 'processing' },
  { id: 'style', name: 'Guia_Estilo_Archivistica.pdf', uploadedAt: '2023-11-01', fragments: 89, status: 'indexed' },
  { id: 'finance', name: 'Reporte_Financiero_Q3.pdf', uploadedAt: '2023-11-10', fragments: 210, status: 'indexed' },
  { id: 'draft', name: 'Borrador_Incompleto.txt', uploadedAt: '2023-11-12', fragments: null, status: 'error' },
]

export function normalize(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}
export const MAX_FILE_BYTES = 50 * 1024 * 1024
export function validateDocument(file: Pick<File, 'name' | 'size'>): string | null {
  if (!/\.(pdf|docx|txt)$/i.test(file.name)) return `${file.name}: formato no admitido. Usa PDF, DOCX o TXT.`
  if (file.size === 0) return `${file.name}: el archivo está vacío.`
  if (file.size > MAX_FILE_BYTES) return `${file.name}: supera el límite de 50 MB.`
  return null
}
export function formatDocumentDate(date: string) {
  return new Intl.DateTimeFormat('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })
    .formatToParts(new Date(`${date}T12:00:00`))
    .filter(part => part.type !== 'literal').map(part => part.value).join(' ')
}
