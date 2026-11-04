// Proveedor OpenAI-compatible simulado para el modo directo (fetch inyectable).
// Distingue la descomposición (prompt de subconsultas) de la redacción y
// registra cada llamada: ruta, cuerpo y cabecera de autorización.
export interface LlamadaLlm { ruta: string; cuerpo: Record<string, any>; autorizacion: string | null }

export function crearLlmSimulado() {
  const estado = {
    llamadas: [] as LlamadaLlm[],
    subconsultas: ['hardship withdrawal eligibility immediate heavy financial need'] as unknown,
    // Respuesta de redacción: por defecto cita las dos primeras secciones.
    redaccion: (): unknown => ({
      respuesta: 'A hardship withdrawal covers an immediate and heavy financial need [1]. The plan must allow it and the reason must be IRS-approved [2].',
      puntos_clave: [{ texto: 'Only for an immediate and heavy financial need.', fuentes: [1] }],
      vacios_de_cobertura: [],
      contradicciones: [],
    }),
    fallar: null as null | 'descomposicion' | 'redaccion',
    colgar: false,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const ruta = new URL(String(input)).pathname
      const cuerpo = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>
      const cabeceras = new Headers(init?.headers)
      estado.llamadas.push({ ruta, cuerpo, autorizacion: cabeceras.get('authorization') })
      if (estado.colgar) {
        await new Promise((_resolver, rechazar) => init?.signal?.addEventListener('abort', () => rechazar(new DOMException('aborted', 'AbortError'))))
      }
      const esDescomposicion = String(cuerpo.messages?.[0]?.content ?? '').startsWith('You are a query decomposition')
      if ((estado.fallar === 'descomposicion' && esDescomposicion) || (estado.fallar === 'redaccion' && !esDescomposicion)) {
        return Response.json({ error: { message: 'fallo simulado' } }, { status: 500 })
      }
      const salida = esDescomposicion ? { sub_queries: estado.subconsultas } : estado.redaccion()
      return Response.json({ choices: [{ message: { content: JSON.stringify(salida) } }] })
    }) as typeof fetch,
  }
  return estado
}

// Llamadas de redacción (no de descomposición).
export function redacciones(llamadas: LlamadaLlm[]): LlamadaLlm[] {
  return llamadas.filter(item => !String(item.cuerpo.messages?.[0]?.content ?? '').startsWith('You are a query decomposition'))
}
