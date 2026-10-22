import type { Umbrales } from './coverage.ts'
import { descomponer } from './decompose.ts'
import type { ContextoConsulta, Contradiccion, Evidencia, Motor, ResultadoMotor } from './motor.ts'
import { KdError, type ErrorCode } from '../errors.ts'
import type { IndiceLocal } from '../index/local.ts'
import type { Coincidencia } from '../index/types.ts'
import { ProveedorError, type Proveedor } from '../providers/openaiCompatible.ts'

const PRESUPUESTO_CARACTERES = 8000
const MAX_POR_DOCUMENTO = 6

export const PROMPT_SISTEMA = `Eres Knowledge Desk, un asistente interno. Respondes solo con la información de las SECCIONES numeradas, que provienen de los documentos aprobados del corpus.
Reglas:
1. No uses conocimiento general ni información externa. Si las secciones no bastan para responder, deja "respuesta" vacía y explica qué falta en "vacios_de_cobertura".
2. Cada afirmación de la respuesta lleva la cita de la sección que la sustenta, con el formato [n].
3. Si dos secciones se contradicen, no elijas una en silencio: descríbelo en "contradicciones" citando ambas.
4. No incluyas datos personales, financieros ni transaccionales de personas concretas.
5. Escribe en el idioma de la pregunta.
Devuelve solo un objeto JSON con esta forma:
{"respuesta": "texto con citas [n]", "puntos_clave": [{"texto": "...", "fuentes": [n]}], "vacios_de_cobertura": ["tema no cubierto"], "contradicciones": [{"descripcion": "...", "fuentes": [n, m]}]}`

function errorProveedor(error: unknown, codigo: ErrorCode, signal: AbortSignal): KdError {
  if (signal.aborted || (error instanceof ProveedorError && error.tipo === 'timeout')) return new KdError('TIMEOUT', undefined, { origen: 'proveedor' })
  return new KdError(codigo, undefined, { origen: 'proveedor', tipo: error instanceof ProveedorError ? error.tipo : 'desconocido' })
}

function aEvidencia(coincidencia: Coincidencia): Evidencia {
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
        motor: 'local' as const,
        modelo: deps.proveedor.modeloChat,
        subconsultas,
        fragmentosRecuperados: ordenados.length,
        articulosConsultados: new Set(ordenados.map(item => item.articleId)).size,
        nivelMotor: null,
      }

      // 4. Sin evidencia no se llama al modelo: nada se genera desde su memoria.
      if (!relevantes.length) {
        return { ...base, respuesta: '', puntosClave: [], evidencia: [], vaciosCobertura: [], contradicciones: [], generada: false }
      }

      // 5. Contexto acotado y diverso: solo fragmentos del corpus con su origen.
      const contexto: Evidencia[] = []
      const porDocumento = new Map<string, number>()
      let caracteres = 0
      for (const item of relevantes) {
        const usados = porDocumento.get(item.articleId) ?? 0
        if (usados >= MAX_POR_DOCUMENTO || caracteres + item.content.length > PRESUPUESTO_CARACTERES) continue
        contexto.push(item)
        porDocumento.set(item.articleId, usados + 1)
        caracteres += item.content.length
      }
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
    },
  }
}
