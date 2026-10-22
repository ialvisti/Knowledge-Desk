// Descomposición determinista de preguntas con varios temas (HU02). Divide por
// signos de interrogación sucesivos, punto y coma, o una conjunción seguida de
// un nuevo interrogativo ("¿Cuál es el plazo y qué documentos debo adjuntar?").
// Devuelve [] cuando la pregunta trata un solo tema.
// El fin de palabra se comprueba con \p{L}: \b no reconoce "qué" ni "cómo"
// porque trata las vocales acentuadas como no alfabéticas.
const CONECTOR = /\s+(?:y|e)\s+(?=(?:qu[eé]|c[oó]mo|cu[aá]nt[oa]s?|cu[aá]l(?:es)?|d[oó]nde|cu[aá]ndo|qui[eé]n(?:es)?|por qu[eé])(?![\p{L}\d]))/iu

export function descomponer(pregunta: string): string[] {
  const partes = pregunta
    .split(/(?<=\?)\s+|;\s+/)
    .flatMap(parte => parte.split(CONECTOR))
    .map(parte => parte.replace(/^[¿\s]+|[?\s]+$/g, '').trim())
    .filter(parte => parte.split(/\s+/).length >= 3)
  if (partes.length < 2) return []
  return partes.slice(0, 3).map(parte => `¿${parte}?`)
}
