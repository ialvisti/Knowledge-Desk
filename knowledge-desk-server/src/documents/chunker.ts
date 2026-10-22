import { createHash } from 'node:crypto'
import type { Articulo, Json, Objeto } from './articulo.ts'

// Port del chunker de ForUsGuide (kb-rag-system/data_pipeline/chunking.py,
// KBChunker). Conserva el orden, los formatos de texto, los tipos, categorías y
// niveles, de modo que los fragmentos de Knowledge Desk compitan en igualdad con
// los del corpus de ForUsGuide en el endpoint knowledge-question.
// Diferencias deliberadas, documentadas:
//  - Cada fragmento guarda las rutas JSON de origen (p. ej. details.steps[0]).
//  - Un fragmento cuyos campos de datos no tienen texto no se indexa (se
//    decide sobre el JSON, no sobre los encabezados que añade el formato).
//  - Las líneas con valor null se omiten en vez de imprimir "None".
//  - Un fragmento de más de MAXIMO_FRAGMENTO caracteres se divide en partes
//    sin truncar: Pinecone limita los metadatos a 40 KB por registro y el
//    modelo de embeddings recorta entradas largas.

export const REGLA_FRAGMENTACION = 'forusguide-kbchunker-port-v1'
export const MAXIMO_FRAGMENTO = 4000

export type Nivel = 'critical' | 'high' | 'medium' | 'low'

export interface Fragmento {
  indice: number
  texto: string
  tipo: string
  categoria: string
  nivel: Nivel
  temas: string[]
  rutas: string[]
  parte: [number, number] | null
  hash: string
  extra: Record<string, string[]>
}

// Los datos del JSON que alimentan el texto de un fragmento.
type Borrador = Omit<Fragmento, 'indice' | 'hash' | 'parte'> & { datos: Json[] }

const lista = (valor: Json | undefined): Json[] => (Array.isArray(valor) ? valor : [])
const objeto = (valor: Json | undefined): Objeto => (typeof valor === 'object' && valor !== null && !Array.isArray(valor) ? valor : {})
const tieneValor = (valor: Json | undefined) => valor !== undefined && valor !== null && valor !== ''
const texto = (valor: Json | undefined) => (typeof valor === 'string' ? valor : valor === undefined || valor === null ? '' : JSON.stringify(valor))
const titulo = (valor: string) => valor.replace(/_/g, ' ').replace(/\b\p{L}/gu, letra => letra.toUpperCase())

function linea(lineas: string[], etiqueta: string, valor: Json | undefined) {
  if (tieneValor(valor)) lineas.push(`${etiqueta}${texto(valor)}`)
}

function viñetas(lineas: string[], encabezado: string, valores: Json[]) {
  const visibles = valores.filter(tieneValor)
  if (!visibles.length) return
  lineas.push(encabezado)
  for (const valor of visibles) lineas.push(`- ${texto(valor)}`)
  lineas.push('')
}

// --- Formatos (mismo texto que chunking.py) -------------------------------

function mustHave(campos: Json[]) {
  const lineas = ['# Required Data — Must Have (Portal/Profile Data)\n', 'These fields MUST be collected from the participant portal or profile system.\n']
  for (const crudo of campos) {
    const campo = objeto(crudo)
    lineas.push(`### ${texto(campo.data_point)}`)
    linea(lineas, '**Description:** ', campo.meaning)
    linea(lineas, '**Why needed:** ', campo.why_needed)
    lineas.push(`**Source:** ${texto(campo.source_type) || 'participant_data'}`)
    lineas.push(`**Blocking intent:** ${texto(campo.blocking_intent) || 'always'}`)
    const ejemplos = campo.example_values
    if (Array.isArray(ejemplos)) {
      const validos = ejemplos.filter(tieneValor).map(texto)
      if (validos.length) lineas.push(`**Examples:** ${validos.join(', ')}`)
    } else if (tieneValor(ejemplos)) lineas.push(`**Example:** ${texto(ejemplos)}`)
    lineas.push('')
  }
  return lineas.join('\n')
}

function niceToHave(campos: Json[]) {
  const lineas = ['# Required Data — Nice to Have (Conversation Context)\n', "These fields are OPTIONAL and typically extracted from the participant's message.\n"]
  for (const crudo of campos) {
    const campo = objeto(crudo)
    lineas.push(`### ${texto(campo.data_point)}`)
    linea(lineas, '**Description:** ', campo.meaning)
    linea(lineas, '**Why needed:** ', campo.why_needed)
    lineas.push(`**Source:** ${texto(campo.source_type) || 'message_text'}`)
    const ejemplos = lista(campo.example_values).filter(tieneValor).map(texto)
    if (ejemplos.length) lineas.push(`**Examples:** ${ejemplos.join(', ')}`)
    lineas.push('')
  }
  return lineas.join('\n')
}

function ifMissing(items: Json[]) {
  const lineas = ['# Required Data — If Missing (What to Ask)\n', 'When a required data point is not available, use these prompts to collect it.\n']
  for (const crudo of items) {
    const item = objeto(crudo)
    lineas.push(`### Missing: ${texto(item.missing_data_point)}`)
    linea(lineas, '**Ask participant:** ', item.ask_participant)
    linea(lineas, '**Agent note:** ', item.agent_note)
    lineas.push('')
  }
  return lineas.join('\n')
}

function disambiguation(notas: Json[]) {
  return ['# Required Data — Disambiguation Notes\n', 'Edge-case logic and decision rules for interpreting participant data.\n', ...notas.filter(tieneValor).map(nota => `- ${texto(nota)}`)].join('\n')
}

function criticalFlags(flags: Objeto) {
  return ['# Critical Flags\n', ...Object.entries(flags).filter(([, valor]) => valor !== null).map(([clave, valor]) => `**${clave}:** ${typeof valor === 'boolean' ? (valor ? 'True' : 'False') : texto(valor)}`)].join('\n')
}

function businessRules(grupos: Objeto[], encabezado: string) {
  const lineas = [`# Business Rules: ${encabezado}\n`]
  for (const grupo of grupos) {
    const reglas = lista(grupo.rules).filter(tieneValor)
    if (!reglas.length) continue
    lineas.push(`## ${titulo(texto(grupo.category) || 'general')}:`)
    for (const regla of reglas) lineas.push(`- ${texto(regla)}`)
    lineas.push('')
  }
  return lineas.join('\n')
}

function decisionGuide(guia: Objeto) {
  const lineas = ['# Decision Guide\n']
  viñetas(lineas, '## Supported Outcomes:', lista(guia.supported_outcomes))
  viñetas(lineas, '## Eligibility Requirements:', lista(guia.eligibility_requirements))
  viñetas(lineas, '## Blocking Conditions:', lista(guia.blocking_conditions))
  const faltantes = lista(guia.missing_data_conditions)
  if (faltantes.length) {
    lineas.push('## Missing Data Scenarios:')
    for (const crudo of faltantes) {
      const item = objeto(crudo)
      linea(lineas, '\n**Condition:** ', item.condition)
      linea(lineas, '**Missing:** ', item.missing_data_point)
      linea(lineas, '**Outcome:** ', item.resulting_outcome)
      linea(lineas, '**Ask:** ', item.ask_participant)
    }
  }
  viñetas(lineas, '\n## Allowed Conclusions:', lista(guia.allowed_conclusions))
  viñetas(lineas, '\n## Not Allowed Conclusions:', lista(guia.not_allowed_conclusions))
  return lineas.join('\n')
}

function responseFrames(marcos: Objeto) {
  const lineas = ['# Response Frames by Outcome\n']
  for (const [resultado, crudo] of Object.entries(marcos)) {
    const marco = objeto(crudo)
    lineas.push(`\n## Outcome: ${resultado}\n`)
    viñetas(lineas, '### Message Components:', lista(marco.participant_message_components))
    viñetas(lineas, '### Next Steps:', lista(marco.next_steps))
    viñetas(lineas, '### Warnings:', lista(marco.warnings))
    viñetas(lineas, '### Questions to Ask:', lista(marco.questions_to_ask))
    viñetas(lineas, '### Do NOT Say:', lista(marco.what_not_to_say))
  }
  return lineas.join('\n')
}

function guardrails(datos: Objeto) {
  const lineas = ['# Guardrails and Safety Rules\n']
  viñetas(lineas, '## Must NOT Say:', lista(datos.must_not))
  viñetas(lineas, '## Must Do If Unsure:', lista(datos.must_do_if_unsure))
  return lineas.join('\n')
}

function steps(pasos: Objeto[]) {
  const lineas = ['# Step-by-Step Procedure\n']
  for (const paso of pasos) {
    lineas.push(`## Step ${texto(paso.step_number)}: ${texto(paso.description)}`)
    linea(lineas, '**Note:** ', paso.notes)
    lineas.push('')
  }
  return lineas.join('\n')
}

function commonIssues(casos: Objeto[]) {
  const lineas = ['# Common Issues and Resolutions\n']
  for (const caso of casos) {
    lineas.push(`## Issue: ${texto(caso.issue)}`)
    linea(lineas, '**Resolution:** ', caso.resolution)
    lineas.push('')
  }
  return lineas.join('\n')
}

function fees(cargos: Json[]) {
  const lineas = ['# Fees and Charges\n', '## Fee Details:']
  for (const crudo of cargos) {
    const cargo = objeto(crudo)
    lineas.push(`\n**${texto(cargo.service)}:** ${texto(cargo.fee)}`)
    if (tieneValor(cargo.notes)) lineas.push(`*${texto(cargo.notes)}*`)
  }
  return lineas.join('\n')
}

function faqs(pares: Objeto[]) {
  const lineas = ['# Frequently Asked Questions\n']
  for (const par of pares) {
    lineas.push(`## Q: ${texto(par.question)}`)
    lineas.push(`**A:** ${texto(par.answer)}`)
    lineas.push('')
  }
  return lineas.join('\n')
}

function definitions(definiciones: Json[]) {
  const lineas = ['# Definitions and Terms\n']
  for (const crudo of definiciones) {
    const definicion = objeto(crudo)
    lineas.push(`## ${texto(definicion.term)}`)
    lineas.push(texto(definicion.definition))
    lineas.push('')
  }
  return lineas.join('\n')
}

function additionalNotes(grupo: Objeto) {
  return [`# Additional Information: ${titulo(texto(grupo.category) || 'General')}\n`, ...lista(grupo.notes).filter(tieneValor).map(nota => `- ${texto(nota)}`)].join('\n')
}

function references(referencias: Objeto) {
  const lineas = ['# References and Resources\n']
  if (tieneValor(referencias.participant_portal)) lineas.push(`**Participant Portal:** ${texto(referencias.participant_portal)}`, '')
  const contacto = objeto(referencias.contact)
  if (Object.values(contacto).some(tieneValor)) {
    lineas.push('## Contact Information:')
    linea(lineas, '**Email:** ', contacto.email)
    linea(lineas, '**Phone:** ', contacto.phone)
    linea(lineas, '**Hours:** ', contacto.support_hours)
    lineas.push('')
  }
  viñetas(lineas, '## Related Internal Articles:', lista(referencias.internal_articles))
  // external_links aparece en el corpus como textos o como {label, url, purpose}.
  const externos = lista(referencias.external_links).map(enlace => {
    if (typeof enlace === 'string') return enlace
    const datos = objeto(enlace)
    return [datos.label, datos.url, datos.purpose].filter(tieneValor).map(texto).join(' — ')
  })
  viñetas(lineas, '## External Resources:', externos)
  return lineas.join('\n')
}

// --- Agrupaciones de chunking.py -----------------------------------------

function grupos<T>(items: T[], tamaño: number): T[][] {
  const resultado: T[][] = []
  for (let inicio = 0; inicio < items.length; inicio += tamaño) resultado.push(items.slice(inicio, inicio + tamaño))
  return resultado
}

function categoriaDeIncidencia(caso: Objeto): 'access' | 'process' | 'technical' {
  const descripcion = texto(caso.issue).toLowerCase()
  if (['login', 'access', 'portal', 'password'].some(palabra => descripcion.includes(palabra))) return 'access'
  if (['wire', 'check', 'delivery', 'received'].some(palabra => descripcion.includes(palabra))) return 'process'
  return 'technical'
}

function rango(base: string, desde: number, hasta: number) {
  return Array.from({ length: hasta - desde + 1 }, (_, posicion) => `${base}[${desde + posicion}]`)
}

// ¿Hay conocimiento real en estos DATOS? Se decide sobre el JSON de la sección y
// no sobre el texto formateado: la descripción de un paso vive en un
// encabezado ("## Step 1: …") y sigue siendo contenido. Basta un texto con
// alguna letra o cifra; null, "", listas vacías y booleanos no cuentan.
export function hayTexto(valor: Json | undefined): boolean {
  if (typeof valor === 'string') return /\p{L}|\p{N}/u.test(valor)
  if (typeof valor === 'number') return true
  if (Array.isArray(valor)) return valor.some(hayTexto)
  if (valor && typeof valor === 'object') return Object.values(valor).some(hayTexto)
  return false
}

// Valores de los campos que un formato imprime. Solo ellos deciden si una
// sección tiene contenido: claves ajenas al esquema se conservan en el original,
// pero no se indexan y no pueden hacer pasar por útil un artículo vacío.
const campos = (items: Json[], ...claves: string[]): Json[] => items.flatMap(item => claves.map(clave => objeto(item)[clave] ?? null))

function borradores(articulo: Articulo): Borrador[] {
  const d = articulo.details
  const salida: Borrador[] = []
  const agregar = (datos: Json[], contenido: string, tipo: string, categoria: string, nivel: Nivel, temas: string[], rutas: string[], extra: Record<string, string[]> = {}) => {
    if (hayTexto(datos)) salida.push({ texto: contenido, tipo, categoria, nivel, temas, rutas, extra, datos })
  }
  const datoRequerido = ['data_point', 'meaning', 'why_needed', 'example_values']

  // MODO A: required_data
  const requeridos = objeto(d.required_data)
  const imprescindibles = lista(requeridos.must_have)
  if (imprescindibles.length) {
    const intenciones = imprescindibles.map(objeto).filter(campo => tieneValor(campo.data_point)).map(campo => `${texto(campo.data_point)}|${texto(campo.blocking_intent) || 'always'}`)
    agregar(campos(imprescindibles, ...datoRequerido), mustHave(imprescindibles), 'required_data_must_have', 'portal_data_extraction', 'critical', ['data_requirements', 'must_have', 'portal_data'], ['details.required_data.must_have'], intenciones.length ? { must_have_blocking_intents: intenciones } : {})
  }
  const opcionales = lista(requeridos.nice_to_have)
  if (opcionales.length) agregar(campos(opcionales, ...datoRequerido), niceToHave(opcionales), 'required_data_nice_to_have', 'conversation_context', 'medium', ['data_requirements', 'nice_to_have', 'message_context'], ['details.required_data.nice_to_have'])
  const faltantes = lista(requeridos.if_missing)
  if (faltantes.length) agregar(campos(faltantes, 'missing_data_point', 'ask_participant', 'agent_note'), ifMissing(faltantes), 'required_data_if_missing', 'missing_data_handling', 'high', ['data_requirements', 'if_missing', 'data_gaps'], ['details.required_data.if_missing'])
  const notasDesambiguacion = lista(requeridos.disambiguation_notes)
  if (notasDesambiguacion.length) agregar(notasDesambiguacion, disambiguation(notasDesambiguacion), 'required_data_disambiguation', 'decision_logic', 'medium', ['data_requirements', 'disambiguation', 'edge_cases'], ['details.required_data.disambiguation_notes'])

  const reglas = lista(d.business_rules).map(objeto)
  const elegibilidad = reglas.map((grupo, indice) => ({ grupo, indice })).filter(item => item.grupo.category === 'eligibility')
  if (elegibilidad.length) {
    agregar(campos(elegibilidad.map(item => item.grupo), 'rules'), businessRules(elegibilidad.map(item => item.grupo), 'Eligibility'), 'eligibility', 'requirements', 'critical', ['eligibility', 'requirements'], elegibilidad.map(item => `details.business_rules[${item.indice}]`))
  }
  // Una bandera cuenta si está activa (true) o fija un valor de texto.
  const banderas = objeto(d.critical_flags)
  const activas = Object.entries(banderas).flatMap(([clave, valor]): Json[] => (valor === true ? [clave] : typeof valor === 'string' ? [valor] : []))
  agregar(activas, criticalFlags(banderas), 'critical_flags', 'validation', 'critical', ['flags', 'validation'], ['details.critical_flags'])

  // MODO B · Tier 1
  const guia = objeto(d.decision_guide)
  agregar([
    ...campos([guia], 'supported_outcomes', 'eligibility_requirements', 'blocking_conditions', 'allowed_conclusions', 'not_allowed_conclusions'),
    ...campos(lista(guia.missing_data_conditions), 'condition', 'missing_data_point', 'resulting_outcome', 'ask_participant'),
  ], decisionGuide(guia), 'decision_guide', 'decision_making', 'critical', ['decision', 'outcomes', 'eligibility'], ['details.decision_guide'])
  const marcos = objeto(d.response_frames)
  agregar(campos(Object.values(marcos), 'participant_message_components', 'next_steps', 'warnings', 'questions_to_ask', 'what_not_to_say'), responseFrames(marcos), 'response_frames', 'response_templates', 'critical', ['response', 'communication'], ['details.response_frames'])
  const limites = objeto(d.guardrails)
  agregar(campos([limites], 'must_not', 'must_do_if_unsure'), guardrails(limites), 'guardrails', 'safety', 'critical', ['guardrails', 'safety', 'compliance'], ['details.guardrails'])
  reglas.forEach((grupo, indice) => {
    const categoria = texto(grupo.category) || 'general'
    agregar(campos([grupo], 'rules'), businessRules([grupo], titulo(categoria)), 'business_rules', categoria, ['fees', 'eligibility', 'tax_withholding'].includes(categoria) ? 'critical' : 'high', [categoria, 'rules', 'policy'], [`details.business_rules[${indice}]`])
  })

  // MODO B · Tier 2
  const pasos = lista(d.steps).map(objeto)
  grupos(pasos, 3).forEach((grupo, numero) => {
    const primero = texto(grupo[0].step_number) || String(numero * 3 + 1)
    const ultimo = texto(grupo[grupo.length - 1].step_number) || String((numero + 1) * 3)
    // La descripción de un paso es conocimiento aunque el paso no tenga notas.
    agregar(campos(grupo, 'description', 'notes'), steps(grupo), 'steps', `steps_${primero}_to_${ultimo}`, 'high', ['procedure', 'steps', 'process'], rango('details.steps', numero * 3, numero * 3 + grupo.length - 1))
  })
  const incidencias = lista(d.common_issues).map(objeto)
  for (const categoria of ['access', 'process', 'technical'] as const) {
    const delGrupo = incidencias.map((caso, indice) => ({ caso, indice })).filter(item => categoriaDeIncidencia(item.caso) === categoria)
    if (delGrupo.length) agregar(campos(delGrupo.map(item => item.caso), 'issue', 'resolution'), commonIssues(delGrupo.map(item => item.caso)), 'common_issues', categoria, 'high', ['troubleshooting', 'issues', 'problems'], delGrupo.map(item => `details.common_issues[${item.indice}]`))
  }
  lista(d.examples).map(objeto).forEach((ejemplo, indice) => {
    agregar(campos([ejemplo], 'scenario', 'outcome'), `# Example Scenario\n\n**Scenario:** ${texto(ejemplo.scenario)}\n\n**Outcome:** ${texto(ejemplo.outcome)}`, 'example', `scenario_${indice + 1}`, 'medium', ['example', 'scenario', 'use_case'], [`details.examples[${indice}]`])
  })
  const cargos = lista(d.fees)
  if (cargos.length) agregar(campos(cargos, 'service', 'fee', 'notes'), fees(cargos), 'fees_details', 'costs', 'high', ['fees', 'costs', 'charges'], ['details.fees'])

  // MODO B · Tier 3
  grupos(lista(d.faq_pairs).map(objeto), 3).forEach((grupo, numero) => {
    agregar(campos(grupo, 'question', 'answer'), faqs(grupo), 'faqs', `group_${numero + 1}`, 'low', ['faq', 'questions'], rango('details.faq_pairs', numero * 3, numero * 3 + grupo.length - 1))
  })
  const definiciones = lista(d.definitions)
  if (definiciones.length) agregar(campos(definiciones, 'term', 'definition'), definitions(definiciones), 'definitions', 'glossary', 'low', ['definitions', 'terms', 'glossary'], ['details.definitions'])
  const notas = lista(d.additional_notes)
  if (notas.length && typeof notas[0] === 'string') {
    agregar(notas, additionalNotes({ category: 'general', notes: notas }), 'additional_notes', 'general', 'low', ['notes', 'additional_info', 'general'], ['details.additional_notes'])
  } else {
    notas.map(objeto).forEach((grupo, indice) => {
      const categoria = texto(grupo.category) || 'general'
      agregar(campos([grupo], 'notes'), additionalNotes(grupo), 'additional_notes', categoria, 'low', ['notes', 'additional_info', categoria], [`details.additional_notes[${indice}]`])
    })
  }
  const referencias = objeto(d.references)
  agregar([
    ...campos([referencias], 'participant_portal', 'internal_articles'),
    ...campos([objeto(referencias.contact)], 'email', 'phone', 'support_hours'),
    ...lista(referencias.external_links).flatMap(enlace => (typeof enlace === 'string' ? [enlace] : campos([enlace], 'label', 'url', 'purpose'))),
  ], references(referencias), 'references', 'links', 'low', ['references', 'links', 'resources'], ['details.references'])
  return salida
}

// ¿Tiene el artículo contenido que sustente respuestas? Se mide sobre los datos
// que efectivamente se indexan (no sobre claves ajenas, encabezados del chunker
// ni banderas): hacen falta al menos 40 letras.
export function contenidoUtil(articulo: Articulo): boolean {
  let letras = 0
  const contar = (valor: Json) => {
    if (typeof valor === 'string') letras += (valor.match(/\p{L}/gu) ?? []).length
    else if (Array.isArray(valor)) valor.forEach(contar)
    else if (valor && typeof valor === 'object') Object.values(valor).forEach(contar)
  }
  for (const borrador of borradores(articulo)) if (borrador.tipo !== 'critical_flags') contar(borrador.datos)
  return letras >= 40
}

// Divide un texto largo en partes que nunca superan el máximo, sin perder
// caracteres: primero por líneas y, si una línea sola es mayor, por espacios.
// Invariantes: el máximo efectivo es al menos 1 y cada corte avanza.
export function partir(contenido: string, maximo: number): string[] {
  const limite = Math.max(1, Math.floor(maximo))
  if (contenido.length <= limite) return [contenido]
  const piezas: string[] = []
  for (const fila of contenido.split('\n')) {
    if (fila.length <= limite) { piezas.push(fila); continue }
    let resto = fila
    while (resto.length > limite) {
      let corte = resto.lastIndexOf(' ', limite)
      if (corte < limite / 2 || corte < 1) corte = limite
      piezas.push(resto.slice(0, corte))
      resto = resto.slice(corte)
    }
    if (resto) piezas.push(resto)
  }
  const partes: string[] = []
  let actual: string | null = null
  for (const pieza of piezas) {
    if (actual !== null && actual.length + pieza.length + 1 > limite) {
      partes.push(actual)
      actual = pieza
    } else {
      actual = actual === null ? pieza : `${actual}\n${pieza}`
    }
  }
  if (actual) partes.push(actual)
  return partes
}

// El encabezado que se repite en cada parte se acota: una categoría o un
// título enormes no pueden dejar sin espacio al contenido.
const MAX_ENCABEZADO = 160

export function fragmentarArticulo(articulo: Articulo): Fragmento[] {
  const fragmentos: Fragmento[] = []
  for (const { datos: _datos, ...borrador } of borradores(articulo)) {
    const primera = borrador.texto.split('\n')[0]
    const encabezado = primera.length > MAX_ENCABEZADO ? `${primera.slice(0, MAX_ENCABEZADO - 1)}…` : primera
    // Cada parte repite el encabezado del fragmento para entenderse aislada.
    const reserva = encabezado.length + 24
    const partes = partir(borrador.texto, MAXIMO_FRAGMENTO - reserva)
    partes.forEach((parte, posicion) => {
      const contenido = posicion === 0 ? parte : `${encabezado} (parte ${posicion + 1} de ${partes.length})\n${parte}`
      fragmentos.push({
        ...borrador,
        indice: fragmentos.length + 1,
        texto: contenido,
        parte: partes.length > 1 ? [posicion + 1, partes.length] : null,
        hash: createHash('md5').update(contenido).digest('hex').slice(0, 8),
      })
    })
  }
  return fragmentos
}
