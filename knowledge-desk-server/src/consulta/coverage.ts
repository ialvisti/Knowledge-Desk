import type { Evidencia } from './motor.ts'

export type NivelCobertura = 'alta' | 'parcial' | 'baja' | 'sin_evidencia'

export interface Umbrales { minScore: number; altaScore: number; mediaScore: number }

export interface Cobertura {
  level: NivelCobertura
  label: string
  explanation: string
  sufficient: boolean
  relevant_fragments: number
  total_fragments: number
  documents: number
  policy: 'kd-cobertura-v1'
  basis: 'motor' | 'politica'
}

const TEXTOS: Record<NivelCobertura, { label: string; explanation: string }> = {
  alta: { label: 'Cobertura alta', explanation: 'Varias fuentes aprobadas tratan directamente tu consulta.' },
  parcial: { label: 'Cobertura parcial', explanation: 'Las fuentes cubren parte de la consulta. Revisa los documentos antes de usar la respuesta.' },
  baja: { label: 'Cobertura baja', explanation: 'La documentación disponible apenas toca tu consulta. No es suficiente para responder con confianza.' },
  sin_evidencia: { label: 'Sin evidencia', explanation: 'No se encontró ningún fragmento relevante en las fuentes aprobadas.' },
}

const DESDE_MOTOR: Record<string, NivelCobertura> = {
  well_covered: 'alta',
  partially_covered: 'parcial',
  limited_coverage: 'baja',
}

// Política kd-cobertura-v1 (HU05). Es reproducible: con la misma evidencia da el
// mismo nivel. NO es una probabilidad de que la respuesta sea correcta; mide
// cuánta evidencia relevante del corpus sustenta la consulta.
//  1. Relevante = fragmento usado con afinidad >= minScore.
//  2. Sin fragmentos relevantes → sin_evidencia.
//  3. Si el motor calcula su propio nivel (ForUsGuide), se respeta.
//  4. Si no: con 2 o más vacíos declarados → baja; con 1 vacío → parcial solo si
//     la media de las 5 mejores afinidades >= altaScore y hay 2+ relevantes;
//     sin vacíos → alta si media >= altaScore y 2+ relevantes, parcial si
//     media >= mediaScore, baja en otro caso.
//  5. Solo alta y parcial son suficientes para presentar una respuesta generada.
export function evaluarCobertura(evidencia: Evidencia[], nivelMotor: string | null, vacios: string[], umbrales: Umbrales): Cobertura {
  const relevantes = evidencia.filter(item => item.score >= umbrales.minScore)
  const documentos = new Set(relevantes.map(item => item.articleId)).size
  let level: NivelCobertura
  let basis: Cobertura['basis'] = 'politica'
  if (!relevantes.length) {
    level = 'sin_evidencia'
  } else if (nivelMotor && DESDE_MOTOR[nivelMotor]) {
    level = DESDE_MOTOR[nivelMotor]
    basis = 'motor'
  } else {
    const mejores = relevantes.map(item => item.score).sort((a, b) => b - a).slice(0, 5)
    const media = mejores.reduce((total, score) => total + score, 0) / mejores.length
    if (vacios.length >= 2) level = 'baja'
    else if (vacios.length === 1) level = media >= umbrales.altaScore && relevantes.length >= 2 ? 'parcial' : 'baja'
    else if (media >= umbrales.altaScore && relevantes.length >= 2) level = 'alta'
    else if (media >= umbrales.mediaScore) level = 'parcial'
    else level = 'baja'
  }
  return {
    level,
    ...TEXTOS[level],
    sufficient: level === 'alta' || level === 'parcial',
    relevant_fragments: relevantes.length,
    total_fragments: evidencia.length,
    documents: documentos,
    policy: 'kd-cobertura-v1',
    basis,
  }
}
