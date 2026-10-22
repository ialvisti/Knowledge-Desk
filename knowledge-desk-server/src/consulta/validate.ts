import { KdError } from '../errors.ts'

export const MIN_PREGUNTA = 10
export const MAX_PREGUNTA = 2000

// Se valida antes de iniciar cualquier recuperación o generación (HU10). La
// longitud se mide en puntos de código, igual que el backend de ForUsGuide.
export function validarPregunta(cuerpo: unknown): string {
  const pregunta = typeof cuerpo === 'object' && cuerpo !== null ? (cuerpo as { question?: unknown }).question : undefined
  if (typeof pregunta !== 'string') {
    throw new KdError('VALIDATION_ERROR', 'La pregunta no es válida: falta el texto de la consulta.', { motivo: 'formato' })
  }
  const limpia = pregunta.trim()
  const largo = Array.from(limpia).length
  if (!largo) throw new KdError('VALIDATION_ERROR', 'La pregunta no es válida: no puede estar vacía.', { motivo: 'vacia' })
  if (largo < MIN_PREGUNTA) throw new KdError('VALIDATION_ERROR', `La pregunta no es válida: necesita al menos ${MIN_PREGUNTA} caracteres.`, { motivo: 'corta' })
  if (largo > MAX_PREGUNTA) throw new KdError('VALIDATION_ERROR', `La pregunta no es válida: no puede superar ${MAX_PREGUNTA} caracteres.`, { motivo: 'larga' })
  return limpia
}
