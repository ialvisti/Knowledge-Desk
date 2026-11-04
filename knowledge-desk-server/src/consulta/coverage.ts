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
//  3. Nivel de la política, a partir de la evidencia y de los vacíos declarados
//     (normalizados: sin espacios sobrantes, sin vacíos en blanco ni repetidos):
//     con 2 o más vacíos, baja; con 1 vacío, parcial solo si la media de las 5
//     mejores afinidades >= altaScore y hay 2+ relevantes, si no baja; sin
//     vacíos, alta si media >= altaScore y 2+ relevantes, parcial si
//     media >= mediaScore, baja en otro caso.
//  4. Si el motor declara su propio nivel (ForUsGuide), ese nivel es el techo:
//     se usa el menor entre el del motor y el de la política. La evidencia y los
//     vacíos pueden bajar el nivel del motor, nunca subirlo. Si el motor no
//     declara un nivel reconocido, se usa el de la política.
//  5. Solo alta y parcial son suficientes para presentar una respuesta generada.
//  6. Si la política da baja y hay vacíos declarados, la explicación lo dice, con
//     o sin nivel del motor: "apenas toca tu consulta" sería falso cuando la
//     evidencia es fuerte y lo que falta son partes de la pregunta.
const ORDEN: Record<NivelCobertura, number> = { sin_evidencia: 0, baja: 1, parcial: 2, alta: 3 }

const POR_VACIOS = 'El servicio de consulta declaró que la documentación recuperada no cubre partes de la pregunta. No es suficiente para responder con confianza.'

// Un vacío en blanco no es un vacío, y el mismo vacío repetido (con otros
// espacios o mayúsculas) cuenta una sola vez.
export function normalizarVacios(vacios: unknown[]): string[] {
  const vistos = new Set<string>()
  const salida: string[] = []
  for (const vacio of vacios) {
    if (typeof vacio !== 'string') continue
    const limpio = vacio.normalize('NFC').replace(/\s+/g, ' ').trim()
    const clave = limpio.toLocaleLowerCase('es')
    if (!limpio || vistos.has(clave)) continue
    vistos.add(clave)
    salida.push(limpio)
  }
  return salida
}

function nivelDePolitica(relevantes: Evidencia[], vacios: string[], umbrales: Umbrales): NivelCobertura {
  const mejores = relevantes.map(item => item.score).sort((a, b) => b - a).slice(0, 5)
  const media = mejores.reduce((total, score) => total + score, 0) / mejores.length
  if (vacios.length >= 2) return 'baja'
  if (vacios.length === 1) return media >= umbrales.altaScore && relevantes.length >= 2 ? 'parcial' : 'baja'
  if (media >= umbrales.altaScore && relevantes.length >= 2) return 'alta'
  if (media >= umbrales.mediaScore) return 'parcial'
  return 'baja'
}

export function evaluarCobertura(evidencia: Evidencia[], nivelMotor: string | null, vaciosDeclarados: string[], umbrales: Umbrales): Cobertura {
  const vacios = normalizarVacios(vaciosDeclarados)
  const relevantes = evidencia.filter(item => item.score >= umbrales.minScore)
  const documentos = new Set(relevantes.map(item => item.articleId)).size
  let level: NivelCobertura
  let basis: Cobertura['basis'] = 'politica'
  let explicacion: string | null = null
  if (!relevantes.length) {
    level = 'sin_evidencia'
  } else {
    const politica = nivelDePolitica(relevantes, vacios, umbrales)
    const motor = nivelMotor ? DESDE_MOTOR[nivelMotor] : undefined
    if (motor && ORDEN[motor] <= ORDEN[politica]) {
      level = motor
      basis = 'motor'
    } else {
      level = politica
      if (level === 'baja' && vacios.length) explicacion = POR_VACIOS
    }
  }
  return {
    level,
    ...TEXTOS[level],
    ...(explicacion ? { explanation: explicacion } : {}),
    sufficient: level === 'alta' || level === 'parcial',
    relevant_fragments: relevantes.length,
    total_fragments: evidencia.length,
    documents: documentos,
    policy: 'kd-cobertura-v1',
    basis,
  }
}
