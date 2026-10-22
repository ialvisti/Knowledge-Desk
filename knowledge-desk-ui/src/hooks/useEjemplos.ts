import { useEffect, useState } from 'react'
import { obtenerEjemplos } from '../api/servicios'
import { revisionActual, suscribirRevision } from '../state/consultas'

// Ejemplos del corpus activo (HU06). Los define el equipo en el servidor y solo
// llegan los que el corpus puede sustentar; se recargan si el corpus cambia.
export function useEjemplos() {
  const [estado, setEstado] = useState<{ lista: string[]; nota: string | null; cargando: boolean; revision: number }>({ lista: [], nota: null, cargando: true, revision: -2 })
  const [revision, setRevision] = useState(revisionActual())
  useEffect(() => suscribirRevision(() => setRevision(revisionActual())), [])
  useEffect(() => {
    let activo = true
    obtenerEjemplos().then(
      datos => { if (activo) setEstado({ lista: datos.examples, nota: datos.note, cargando: false, revision }) },
      () => { if (activo) setEstado({ lista: [], nota: 'No se pudieron cargar los ejemplos.', cargando: false, revision }) },
    )
    return () => { activo = false }
  }, [revision])
  return estado
}
