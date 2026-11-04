import type { Umbrales } from './coverage.ts'
import { descomponer } from './decompose.ts'
import type { ContextoConsulta, Contradiccion, Evidencia, Motor, ResultadoMotor } from './motor.ts'
import { KdError, type ErrorCode } from '../errors.ts'
import type { IndiceLocal } from '../index/local.ts'
import type { Coincidencia } from '../index/types.ts'
import { ProveedorError, type Proveedor } from '../providers/openaiCompatible.ts'

const PRESUPUESTO_CARACTERES = 8000
const MAX_POR_DOCUMENTO = 6

// La política kd-cobertura-v1 cuenta cada vacío como una parte de la pregunta
// que el corpus no cubre (con 2 o más, cobertura baja). La regla 6 define el
// vacío como en el prompt knowledge-question de ForUsGuide
// (SYSTEM_PROMPT_KNOWLEDGE_QUESTION, reglas 2, 8 y 9): cada objetivo pedido se
// evalúa por separado y lo que falta se declara, pero no los detalles, temas
// vecinos o datos personales que la pregunta no necesita. Sin ella, el modelo
// declaraba esos como vacíos y bloqueaba respuestas sustentadas. La regla 2
// pide la cita en cada oración y viñeta porque así las valida
// unidadesAfirmativas: una frase introductoria sin cita invalida la respuesta.
export const PROMPT_SISTEMA = `Eres Knowledge Desk, un asistente interno. Respondes solo con la información de las SECCIONES numeradas, que provienen de los documentos aprobados del corpus.
Reglas:
1. No uses conocimiento general ni información externa. Si las secciones no bastan para responder, deja "respuesta" vacía y explica qué falta en "vacios_de_cobertura".
2. Cada oración y cada viñeta de la respuesta, también las introductorias o las que dicen de qué depende la respuesta, lleva la cita de la sección que la sustenta, con el formato [n]. Si una oración no se apoya en ninguna sección, no la escribas.
3. Si dos secciones se contradicen, no elijas una en silencio: descríbelo en "contradicciones" citando ambas.
4. No incluyas datos personales, financieros ni transaccionales de personas concretas.
5. Escribe en el idioma de la pregunta.
6. Para "vacios_de_cobertura", evalúa por separado cada objetivo central que pide la pregunta y lista cada uno que las secciones no permiten responder: tratar el tema general no cubre por sí solo los demás objetivos pedidos. Si la pregunta pide expresamente un plazo, un formulario, un requisito o una excepción y las secciones no lo dan, decláralo como vacío; si la pregunta no lo pide, que falte no es un vacío. No declares vacíos por detalles (por ejemplo, el paso a paso de cada variante cuando la pregunta es general), temas secundarios o datos personales que la pregunta no necesita.
7. Si para aplicar una regla documentada faltan datos de quien pregunta (por ejemplo, su edad, su situación laboral o lo que habilita su plan), no los inventes ni confirmes su elegibilidad: explica la condición y qué dato hace falta, con su cita. Esa falta de datos personales no es un vacío de cobertura: la regla sí está documentada.
8. Devuelve "vacios_de_cobertura" vacío solo cuando ningún objetivo central pedido queda sin respaldo en las secciones.
Devuelve solo un objeto JSON con esta forma:
{"respuesta": "texto con citas [n]", "puntos_clave": [{"texto": "...", "fuentes": [n]}], "vacios_de_cobertura": ["objetivo pedido que las secciones no permiten responder"], "contradicciones": [{"descripcion": "...", "fuentes": [n, m]}]}`

export function errorProveedor(error: unknown, codigo: ErrorCode, signal: AbortSignal): KdError {
  if (signal.aborted || (error instanceof ProveedorError && error.tipo === 'timeout')) return new KdError('TIMEOUT', undefined, { origen: 'proveedor' })
  return new KdError(codigo, undefined, { origen: 'proveedor', tipo: error instanceof ProveedorError ? error.tipo : 'desconocido' })
}

export function aEvidencia(coincidencia: Coincidencia): Evidencia {
  const meta = coincidencia.metadata
  return {
    chunkId: coincidencia.id,
    articleId: String(meta.article_id ?? ''),
    articleTitle: String(meta.article_title ?? 'Documento sin título'),
    score: coincidencia.score,
    chunkType: String(meta.chunk_type ?? 'unknown'),
    content: String(meta.content ?? ''),
    paths: Array.isArray(meta.kd_json_paths) ? meta.kd_json_paths.filter((ruta): ruta is string => typeof ruta === 'string') : [],
  }
}

function citas(texto: string): number[] {
  return [...texto.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap(match => match[1].split(',').map(Number))
}

function quitarCitas(texto: string): string {
  return texto.replace(/\s?\[\d+(?:\s*,\s*\d+)*\]/g, '').replace(/[ \t]+([.,;:])/g, '$1').trim()
}

// Unidades que afirman algo: oraciones y viñetas. Los títulos y las frases que
// solo introducen una lista ("Los pasos son:") no necesitan cita propia.
export function unidadesAfirmativas(texto: string): string[] {
  return texto
    .split('\n')
    .flatMap(linea => linea.split(/(?<=[.!?](?:\s*\[\d+(?:\s*,\s*\d+)*\])?)\s+(?=[^\s[])/))
    .map(unidad => unidad.replace(/^\s*(?:[-*•]|\d+[.)]|#{1,6})\s+/, '').trim())
    .filter(unidad => unidad.length >= 12 && !unidad.endsWith(':'))
}

interface SalidaModelo {
  respuesta: string
  puntos: { texto: string; fuentes: number[] }[]
  contradicciones: { descripcion: string; fuentes: number[] }[]
  vacios: string[]
}

function numeros(valor: unknown): number[] {
  return (Array.isArray(valor) ? valor : []).map(Number)
}

function leerSalida(salida: unknown): SalidaModelo {
  const datos = (typeof salida === 'object' && salida !== null ? salida : {}) as Record<string, unknown>
  return {
    respuesta: typeof datos.respuesta === 'string' ? datos.respuesta.trim() : '',
    puntos: (Array.isArray(datos.puntos_clave) ? datos.puntos_clave : []).flatMap(item => {
      const punto = item as { texto?: unknown; fuentes?: unknown }
      return typeof punto.texto === 'string' && punto.texto.trim() ? [{ texto: punto.texto.trim(), fuentes: numeros(punto.fuentes) }] : []
    }),
    contradicciones: (Array.isArray(datos.contradicciones) ? datos.contradicciones : []).flatMap(item => {
      const contradiccion = item as { descripcion?: unknown; fuentes?: unknown }
      return typeof contradiccion.descripcion === 'string' && contradiccion.descripcion.trim() ? [{ descripcion: contradiccion.descripcion.trim(), fuentes: numeros(contradiccion.fuentes) }] : []
    }),
    vacios: (Array.isArray(datos.vacios_de_cobertura) ? datos.vacios_de_cobertura : []).filter((vacio): vacio is string => typeof vacio === 'string' && Boolean(vacio.trim())),
  }
}

export interface OpcionesContexto {
  presupuestoCaracteres: number
  maxPorDocumento: number
  // Tipos de fragmento que entran primero tras el mejor de cada artículo
  // (pipeline knowledge-question de ForUsGuide). Sin valor: orden por afinidad.
  priorizarTipos?: string[]
}

const CONTEXTO_LOCAL: OpcionesContexto = { presupuestoCaracteres: PRESUPUESTO_CARACTERES, maxPorDocumento: MAX_POR_DOCUMENTO }

// Contexto acotado y diverso. Con priorizarTipos se sigue el orden de
// ForUsGuide: primero el mejor fragmento de cada artículo y después los tipos
// prioritarios. Sin él, el orden de siempre del modo local: por afinidad.
export function seleccionarContexto(relevantes: Evidencia[], opciones: OpcionesContexto): Evidencia[] {
  let orden = relevantes
  if (opciones.priorizarTipos) {
    const prioritarios = new Set(opciones.priorizarTipos)
    const mejores = new Map<string, Evidencia>()
    for (const item of relevantes) if (!mejores.has(item.articleId)) mejores.set(item.articleId, item)
    const primeros = [...mejores.values()]
    const resto = relevantes.filter(item => !primeros.includes(item))
    orden = [...primeros, ...resto.filter(item => prioritarios.has(item.chunkType)), ...resto.filter(item => !prioritarios.has(item.chunkType))]
  }
  const contexto: Evidencia[] = []
  const porDocumento = new Map<string, number>()
  let caracteres = 0
  for (const item of orden) {
    const usados = porDocumento.get(item.articleId) ?? 0
    if (usados >= opciones.maxPorDocumento || caracteres + item.content.length > opciones.presupuestoCaracteres) continue
    contexto.push(item)
    porDocumento.set(item.articleId, usados + 1)
    caracteres += item.content.length
  }
  // Las secciones se numeran por afinidad, como en el modo local.
  return contexto.sort((a, b) => b.score - a.score)
}

// Pasos comunes a los modos local y directo: unificar la evidencia, no llamar al
// modelo sin evidencia, construir el contexto y validar que cada afirmación
// cite una sección real.
export async function redactarConEvidencia(
  deps: { proveedor: Proveedor; umbrales: Umbrales; motor: 'local' | 'directo'; contexto?: OpcionesContexto },
  pregunta: string,
  subconsultas: string[],
  resultados: Coincidencia[][],
  signal: AbortSignal,
): Promise<ResultadoMotor> {
  const opcionesContexto = deps.contexto ?? CONTEXTO_LOCAL
  // 3. Unificar y deduplicar ANTES de construir el contexto: un fragmento
  //    encontrado por varias búsquedas cuenta una vez, con su mejor afinidad.
  //    El chunker de ForUsGuide repite a propósito las reglas de
  //    elegibilidad (fragmento "eligibility" y "business_rules"): el mismo
  //    texto del mismo artículo también entra una sola vez.
  const unificados = new Map<string, Coincidencia>()
  for (const lista of resultados) {
    for (const coincidencia of lista) {
      const clave = `${String(coincidencia.metadata.article_id ?? '')}\u0000${String(coincidencia.metadata.content ?? coincidencia.id)}`
      const previa = unificados.get(clave)
      if (!previa || previa.score < coincidencia.score) unificados.set(clave, coincidencia)
    }
  }
  const ordenados = [...unificados.values()].sort((a, b) => b.score - a.score).map(aEvidencia)
  const relevantes = ordenados.filter(item => item.score >= deps.umbrales.minScore)
  const base = {
    motor: deps.motor,
    modelo: deps.proveedor.modeloChat,
    subconsultas,
    fragmentosRecuperados: ordenados.length,
    articulosConsultados: new Set(ordenados.map(item => item.articleId)).size,
    nivelMotor: null,
  }

  // 4. Sin evidencia no se llama al modelo: nada se genera desde su memoria.
  const sinEvidencia = { ...base, respuesta: '', puntosClave: [], evidencia: [], vaciosCobertura: [], contradicciones: [], generada: false }
  if (!relevantes.length) return sinEvidencia

  // 5. Contexto acotado y diverso: solo fragmentos del corpus con su origen.
  //    Un fragmento que no cabe en el presupuesto se omite entero (no se
  //    trunca). Si ninguno cabe, tampoco se llama al modelo.
  const contexto = seleccionarContexto(relevantes, opcionesContexto)
  if (!contexto.length) return sinEvidencia
  const secciones = contexto.map((item, posicion) => `[${posicion + 1}] Fuente: ${item.articleTitle}${item.paths.length ? ` (${item.paths.join(', ')})` : ''}\n${item.content}`)

  let salida: unknown
  try {
    salida = await deps.proveedor.chatJson([
      { role: 'system', content: PROMPT_SISTEMA },
      { role: 'user', content: `SECCIONES:\n${secciones.join('\n\n')}\n\nPREGUNTA:\n${pregunta}` },
    ], signal)
  } catch (error) {
    throw errorProveedor(error, 'AI_PROVIDER_ERROR', signal)
  }

  // 6. Trazabilidad (HU03). Toda afirmación debe citar una sección real del
  //    contexto. Una sola referencia inexistente, una afirmación sin cita o
  //    un punto clave sin fuente válida invalidan la respuesta entera: no se
  //    ocultan citas inventadas ni se presenta como sustentada.
  const { respuesta, puntos, contradicciones: crudas, vacios } = leerSalida(salida)
  const valida = (indice: number) => Number.isInteger(indice) && indice >= 1 && indice <= contexto.length
  const problemas: string[] = []
  const citadas = new Set<number>()

  if (!respuesta) problemas.push('el modelo no redactó una respuesta con el contexto disponible')
  for (const unidad of unidadesAfirmativas(respuesta)) {
    const referencias = citas(unidad)
    if (referencias.some(indice => !valida(indice))) problemas.push('la respuesta cita secciones que no existen en el contexto')
    else if (!referencias.length) problemas.push('la respuesta contiene afirmaciones sin cita')
    referencias.filter(valida).forEach(indice => citadas.add(indice))
  }
  const puntosClave: string[] = []
  for (const punto of puntos) {
    const referencias = [...punto.fuentes, ...citas(punto.texto)]
    if (!referencias.length) problemas.push('un punto clave no indica su fuente')
    else if (referencias.some(indice => !valida(indice))) problemas.push('un punto clave cita secciones que no existen en el contexto')
    else referencias.forEach(indice => citadas.add(indice))
    puntosClave.push(quitarCitas(punto.texto))
  }
  const contradicciones: Contradiccion[] = []
  for (const contradiccion of crudas) {
    if (contradiccion.fuentes.length < 2 || contradiccion.fuentes.some(indice => !valida(indice))) {
      problemas.push('una contradicción declarada no remite a dos secciones reales del contexto')
      continue
    }
    contradiccion.fuentes.forEach(indice => citadas.add(indice))
    contradicciones.push({ descripcion: contradiccion.descripcion, articleIds: [...new Set(contradiccion.fuentes.map(indice => contexto[indice - 1].articleId))] })
  }

  // Las fuentes son las secciones citadas: contexto realmente usado.
  const sustentadas = [...citadas].sort((a, b) => a - b).map(indice => contexto[indice - 1])
  const motivos = [...new Set(problemas)]
  return {
    ...base,
    respuesta: motivos.length ? '' : quitarCitas(respuesta),
    puntosClave: motivos.length ? [] : puntosClave,
    evidencia: sustentadas.length ? sustentadas : contexto,
    vaciosCobertura: vacios,
    contradicciones: motivos.length ? [] : contradicciones,
    generada: true,
    sinSustento: motivos.length > 0,
    motivoSinSustento: motivos.length ? motivos.join('; ') : undefined,
  }
}

export function crearMotorLocal(deps: {
  proveedor: Proveedor
  indice: IndiceLocal
  servible: (articleId: string) => boolean
  umbrales: Umbrales
  topK: number
}): Motor {
  return {
    nombre: 'local',

    async preguntar(pregunta: string, { signal }: ContextoConsulta): Promise<ResultadoMotor> {
      // 1. Pregunta original y subpreguntas, vectorizadas en una sola llamada.
      const subconsultas = descomponer(pregunta)
      let vectores: number[][]
      try {
        vectores = await deps.proveedor.embeddings([pregunta, ...subconsultas], signal)
      } catch (error) {
        throw errorProveedor(error, 'RETRIEVAL_ERROR', signal)
      }

      // 2. Búsquedas por similitud semántica, solo sobre documentos servibles.
      let resultados: Coincidencia[][]
      try {
        resultados = await deps.indice.buscarVectores(vectores, deps.topK, deps.servible)
      } catch {
        throw new KdError('VECTOR_DB_UNAVAILABLE', undefined, { origen: 'indice-local' })
      }

      return redactarConEvidencia({ proveedor: deps.proveedor, umbrales: deps.umbrales, motor: 'local' }, pregunta, subconsultas, resultados, signal)
    },
  }
}
