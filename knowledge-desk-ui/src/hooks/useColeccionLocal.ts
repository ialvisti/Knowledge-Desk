import { useCallback, useEffect, useState } from 'react'
import { listarLocales, listarRegistrosLocales, mensajeErrorLocal, suscribirLocales, type DocumentoLocal, type RegistroLocal } from '../local/documentos'

// Colección local del navegador (IndexedDB). Se vuelve a leer cada vez que el
// motor avisa de un cambio, también si ocurre en otra pestaña del mismo origen:
// lo que se muestra es siempre lo que hay guardado, nunca una copia anterior.
export function useColeccionLocal() {
  const [datos, setDatos] = useState<{ documentos: DocumentoLocal[]; registros: RegistroLocal[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const recargar = useCallback(() => setVersion(valor => valor + 1), [])
  useEffect(() => suscribirLocales(recargar), [recargar])
  useEffect(() => {
    let activo = true
    Promise.all([listarLocales(), listarRegistrosLocales()]).then(([documentos, registros]) => {
      if (!activo) return
      setDatos({ documentos, registros })
      setError(null)
    }, (fallo: unknown) => { if (activo) setError(mensajeErrorLocal(fallo)) })
    return () => { activo = false }
  }, [version])
  return { documentos: datos?.documentos ?? null, registros: datos?.registros ?? null, error, recargar }
}

export interface Almacenamiento { uso: number; cuota: number; persistente: boolean | null }

// Estimación del navegador del espacio que usa este origen y si lo considera
// persistente. Solo existe en contextos seguros (HTTPS o localhost).
export function useAlmacenamiento(revision: unknown) {
  const [info, setInfo] = useState<Almacenamiento | null>(null)
  useEffect(() => {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage
    if (!storage?.estimate) return
    let activo = true
    Promise.all([storage.estimate(), storage.persisted ? storage.persisted() : Promise.resolve(null)]).then(([estimacion, persistente]) => {
      if (activo && estimacion.usage !== undefined && estimacion.quota !== undefined) setInfo({ uso: estimacion.usage, cuota: estimacion.quota, persistente })
    }, () => {})
    return () => { activo = false }
  }, [revision])
  return info
}
