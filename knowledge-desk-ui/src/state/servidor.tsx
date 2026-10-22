import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { ApiError, ERROR_RED } from '../api/cliente'
import { obtenerEstado } from '../api/servicios'
import type { EstadoServidor } from '../api/tipos'
import { observarRevision } from './consultas'

interface ContextoServidor {
  estado: EstadoServidor | null
  error: string | null
  // Vuelve a pedir el estado (y con él la revisión del corpus). Las llamadas
  // simultáneas comparten la misma petición. Resuelve con null si se pudo
  // comprobar y con el error si no: quien espera una verificación decide.
  revalidar: () => Promise<ApiError | null>
}

const Contexto = createContext<ContextoServidor>({ estado: null, error: null, revalidar: () => Promise.resolve(null) })

// Estado del servidor (modo, capacidades configuradas, límites, usuario y
// revisión del corpus). La interfaz nunca supone una integración configurada:
// la lee de aquí. Se revalida al cargar, en cada navegación y al volver a la
// pestaña, para detectar cambios hechos por otro operador.
export function ProveedorServidor({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<EstadoServidor | null>(null)
  const [error, setError] = useState<string | null>(null)
  const enCurso = useRef<Promise<ApiError | null> | null>(null)
  const { key } = useLocation()

  const revalidar = useCallback(() => {
    if (enCurso.current) return enCurso.current
    const promesa = obtenerEstado().then(datos => {
      observarRevision(datos.revisionCorpus, { autoritativa: true })
      setEstado(datos)
      setError(null)
      return null
    }, (fallo: unknown) => {
      const apiError = fallo instanceof ApiError ? fallo : new ApiError(ERROR_RED, 'No hay conexión con el servidor de Knowledge Desk.')
      setError(apiError.message)
      return apiError
    }).finally(() => { enCurso.current = null })
    enCurso.current = promesa
    return promesa
  }, [])

  useEffect(() => { void revalidar() }, [revalidar, key])

  useEffect(() => {
    const alVolver = () => { if (document.visibilityState === 'visible') void revalidar() }
    window.addEventListener('focus', alVolver)
    document.addEventListener('visibilitychange', alVolver)
    return () => {
      window.removeEventListener('focus', alVolver)
      document.removeEventListener('visibilitychange', alVolver)
    }
  }, [revalidar])

  return <Contexto.Provider value={{ estado, error, revalidar }}>{children}</Contexto.Provider>
}

// eslint-disable-next-line react/only-export-components
export function useServidor() {
  return useContext(Contexto)
}
