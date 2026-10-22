import { useEffect, useState } from 'react'
import { obtenerOperacion } from '../api/servicios'
import type { Operacion } from '../api/tipos'

// Consulta una operación del servidor hasta que termina. Lo que se muestra es
// su estado real, paso a paso.
export function useOperacion(id: string | null) {
  const [operacion, setOperacion] = useState<Operacion | null>(null)
  useEffect(() => {
    if (!id) return
    let activo = true
    let temporizador: ReturnType<typeof setTimeout>
    const consultar = () => obtenerOperacion(id).then(({ operacion: datos }) => {
      if (!activo) return
      setOperacion(datos)
      if (datos.resultado === 'en_curso') temporizador = setTimeout(consultar, 700)
    }, () => { if (activo) temporizador = setTimeout(consultar, 1500) })
    consultar()
    return () => { activo = false; clearTimeout(temporizador) }
  }, [id])
  return id && operacion?.id === id ? operacion : null
}
