import { ApiError, nuevoRequestId } from '../api/cliente'
import { consultar, obtenerEstado } from '../api/servicios'
import type { ContratoConsulta } from '../api/tipos'

// Revisión del corpus que conoce la interfaz. Cambia cada vez que el servidor
// informa una carga, un reemplazo o una eliminación (en esta pestaña, en otra
// pestaña o desde otro operador, al revalidar).
let revisionConocida = -1
const oyentes = new Set<() => void>()

// Las pestañas abiertas se avisan entre sí de un cambio del corpus.
const canal = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('knowledge-desk-corpus')

function aplicar(revision: number) {
  revisionConocida = revision
  oyentes.forEach(oyente => oyente())
}

canal?.addEventListener('message', (evento: MessageEvent<{ revision?: unknown }>) => {
  const revision = Number(evento.data?.revision)
  if (Number.isInteger(revision) && revision > revisionConocida) aplicar(revision)
})

export function revisionActual() { return revisionConocida }

// Las respuestas de consulta solo pueden subir la revisión: una respuesta lenta
// no devuelve el corpus a un estado anterior. El estado del servidor y la
// lista de documentos son autoritativos: si el servidor informa una revisión
// menor (se reinició con otros datos), la interfaz la adopta.
export function observarRevision(revision: number, opciones: { autoritativa?: boolean } = {}) {
  if (!Number.isInteger(revision) || revision === revisionConocida) return
  if (revision > revisionConocida) {
    aplicar(revision)
    canal?.postMessage({ revision })
  } else if (opciones.autoritativa) {
    aplicar(revision)
  }
}

export function suscribirRevision(oyente: () => void) {
  oyentes.add(oyente)
  return () => { oyentes.delete(oyente) }
}

export type Resultado =
  | { tipo: 'ok'; contrato: ContratoConsulta; requestId: string }
  | { tipo: 'error'; error: ApiError; requestId: string }

// revision: la revisión del corpus para la que el resultado es válido.
interface Entrada { revision: number; resultado: Resultado }

// Caché de NAVEGACIÓN, no historial conversacional: guarda el resultado de cada
// entrada del historial del navegador para que "atrás" no repita la consulta.
// Una búsqueda nueva crea otra entrada y siempre envía una solicitud. Una
// respuesta deja de valer en cuanto el corpus cambia de revisión.
const cache = new Map<string, Entrada>()
const pendientes = new Map<string, Promise<Resultado>>()
const MAX_ENTRADAS = 30
// Si la respuesta llega de una revisión anterior a la que ya se conoce (el
// corpus cambió mientras se respondía), se repite la consulta con un límite.
export const MAX_REPETICIONES_POR_REVISION = 2

export function leerResultado(clave: string): Resultado | null {
  const entrada = cache.get(clave)
  if (!entrada) return null
  if (entrada.resultado.tipo === 'ok' && entrada.revision !== revisionConocida) {
    cache.delete(clave)
    return null
  }
  return entrada.resultado
}

export function olvidarResultado(clave: string) {
  cache.delete(clave)
}

export const CORPUS_CAMBIADO = 'CORPUS_CHANGED'

async function resolver(pregunta: string, timeoutMs: number): Promise<Entrada> {
  for (let intento = 0; ; intento++) {
    const requestId = nuevoRequestId()
    try {
      const contrato = await consultar(pregunta, requestId, timeoutMs)
      observarRevision(contrato.corpus_revision)
      // Una respuesta queda asociada a la revisión con la que la generó el
      // servidor, nunca a otra. Si el corpus ya cambió, no se presenta: se
      // pregunta otra vez y, agotado el límite, se informa sin mostrarla.
      if (contrato.corpus_revision >= revisionConocida) {
        return { revision: contrato.corpus_revision, resultado: { tipo: 'ok', contrato, requestId: contrato.request_id } }
      }
      if (intento < MAX_REPETICIONES_POR_REVISION) continue
      // Última comprobación con el estado del servidor (autoritativo): si el
      // servidor se reinició con otro corpus, su revisión actual puede ser la
      // de la respuesta, y entonces la respuesta sí es la vigente.
      try {
        observarRevision((await obtenerEstado()).revisionCorpus, { autoritativa: true })
      } catch { /* sin estado no se puede confirmar: se informa abajo */ }
      if (contrato.corpus_revision >= revisionConocida) {
        return { revision: contrato.corpus_revision, resultado: { tipo: 'ok', contrato, requestId: contrato.request_id } }
      }
      const error = new ApiError(CORPUS_CAMBIADO, 'La documentación cambió mientras se preparaba la respuesta y no se pudo obtener una respuesta del corpus vigente. Vuelve a consultar.', { requestId: contrato.request_id })
      return { revision: revisionConocida, resultado: { tipo: 'error', error, requestId: contrato.request_id } }
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('UNKNOWN', 'No se pudo completar la consulta.', { requestId })
      return { revision: revisionConocida, resultado: { tipo: 'error', error: apiError, requestId: apiError.requestId ?? requestId } }
    }
  }
}

// Una sola solicitud en curso por entrada del historial. Lo que se guarda es
// siempre un resultado presentable: una respuesta de la revisión vigente o un
// error con reintento explícito. Así nunca queda una entrada "cargando" sin una
// solicitud que la resuelva, ni una respuesta vieja que pase por vigente.
export function ejecutarConsulta(clave: string, pregunta: string, timeoutMs: number): Promise<Resultado> {
  const enCurso = pendientes.get(clave)
  if (enCurso) return enCurso
  const promesa = resolver(pregunta, timeoutMs)
    .then(entrada => {
      if (cache.size >= MAX_ENTRADAS) {
        const masAntigua = cache.keys().next().value
        if (masAntigua !== undefined) cache.delete(masAntigua)
      }
      cache.set(clave, entrada)
      return entrada.resultado
    })
    .finally(() => { pendientes.delete(clave) })
  pendientes.set(clave, promesa)
  return promesa
}
