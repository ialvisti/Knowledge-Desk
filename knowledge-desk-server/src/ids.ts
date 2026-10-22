import { randomBytes } from 'node:crypto'

const REQUEST_ID = /^req-[0-9a-f]{8}$/

// Identificador de correlación por solicitud (HU10). La interfaz puede proponer
// el suyo para que coincida con lo que muestra aunque la conexión se corte; solo
// se acepta con este formato exacto, así nada externo entra en los registros.
export function requestId(propuesto?: string | string[]): string {
  const valor = Array.isArray(propuesto) ? propuesto[0] : propuesto
  return valor && REQUEST_ID.test(valor) ? valor : `req-${randomBytes(4).toString('hex')}`
}

export function documentoId(secuencia: number): string {
  return `DOC-${String(secuencia).padStart(4, '0')}`
}

export function operacionId(secuencia: number, fecha: Date): string {
  return `OP-${fecha.getFullYear()}-${String(secuencia).padStart(4, '0')}`
}

// Los fragmentos de cada versión comparten un article_id propio. Así una versión
// se lista y se borra por prefijo sin tocar ninguna otra, y el prefijo "kd_"
// distingue el corpus de Knowledge Desk de los artículos de ForUsGuide.
export function articleId(docId: string, version: string): string {
  return `kd_${docId.toLowerCase().replace('-', '')}_v${version.replace('.', '_')}`
}

export function prefijoVersion(docId: string, version: string): string {
  return `${articleId(docId, version)}_chunk_`
}

export function prefijoDocumento(docId: string): string {
  return `kd_${docId.toLowerCase().replace('-', '')}_v`
}

export function chunkId(docId: string, version: string, indice: number): string {
  return `${prefijoVersion(docId, version)}${indice}`
}

export function esArticuloKd(id: string): boolean {
  return id.startsWith('kd_')
}
