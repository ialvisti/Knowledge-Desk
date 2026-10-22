import { useCallback, useEffect, useState } from 'react'
import type { ApiError } from '../api/cliente'
import { ejecutarConsulta, leerResultado, olvidarResultado, revisionActual, suscribirRevision, type Resultado } from '../state/consultas'
import { useServidor } from '../state/servidor'

export type EstadoConsulta =
  | { fase: 'inactiva' }
  | { fase: 'cargando' }
  // Hay una respuesta guardada para esta entrada del historial, pero antes de
  // reutilizarla se comprueba con el servidor que el corpus no cambió.
  | { fase: 'verificando' }
  | { fase: 'lista'; resultado: Resultado }

// Margen sobre el tiempo máximo del servidor: el servidor corta primero y
// responde con su propio TIMEOUT; el navegador solo corta si la red no responde.
const MARGEN_MS = 10_000

export function useConsulta(pregunta: string, clave: string, timeoutServidorMs: number): EstadoConsulta & { reintentar: () => void } {
  const { revalidar } = useServidor()
  const [intento, setIntento] = useState(0)
  const [, setVersion] = useState(0)
  const claveIntento = `${clave}:${intento}`

  // La revisión del corpus forma parte del estado: si cambia (carga, reemplazo
  // o eliminación vistos aquí, en otra pestaña o al revalidar), una respuesta
  // guardada deja de valer y la consulta se vuelve a pedir.
  const [revision, setRevision] = useState(revisionActual)
  useEffect(() => suscribirRevision(() => setRevision(revisionActual())), [])

  // Comprobación de la entrada en este montaje: hecha (sin error), fallida (con
  // el error) o pendiente. Una respuesta recién obtenida no necesita otra.
  const [verificacion, setVerificacion] = useState<{ clave: string; error: ApiError | null } | null>(null)

  const guardado = pregunta ? leerResultado(claveIntento) : null
  const comprobada = verificacion?.clave === claveIntento ? verificacion : null
  const porVerificar = guardado?.tipo === 'ok' && !comprobada
  // Si no se pudo comprobar el corpus, la respuesta guardada NO se muestra: se
  // informa el error y "Reintentar" pide una respuesta nueva.
  const resultado: Resultado | null = guardado?.tipo === 'ok' && comprobada?.error
    ? { tipo: 'error', error: comprobada.error, requestId: comprobada.error.requestId ?? guardado.requestId }
    : guardado
  const estado: EstadoConsulta = !pregunta
    ? { fase: 'inactiva' }
    : resultado ? (porVerificar ? { fase: 'verificando' } : { fase: 'lista', resultado }) : { fase: 'cargando' }

  useEffect(() => {
    if (!porVerificar) return
    let activo = true
    void revalidar().then(error => { if (activo) setVerificacion({ clave: claveIntento, error }) })
    return () => { activo = false }
  }, [porVerificar, claveIntento, revalidar])

  useEffect(() => {
    if (!pregunta || guardado) return
    let activo = true
    // Una sola solicitud por entrada: el doble montaje de StrictMode, un cambio
    // de revisión durante la espera y los reintentos reutilizan la petición en
    // curso. ejecutarConsulta siempre la resuelve para la revisión vigente.
    ejecutarConsulta(claveIntento, pregunta, timeoutServidorMs + MARGEN_MS).then(() => {
      if (!activo) return
      setVerificacion({ clave: claveIntento, error: null })
      setVersion(valor => valor + 1)
    })
    return () => { activo = false }
  }, [pregunta, claveIntento, timeoutServidorMs, guardado, revision])

  const reintentar = useCallback(() => {
    olvidarResultado(claveIntento)
    setIntento(valor => valor + 1)
  }, [claveIntento])

  return { ...estado, reintentar }
}
