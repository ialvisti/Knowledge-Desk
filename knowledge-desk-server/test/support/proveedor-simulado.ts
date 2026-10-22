import { vectorSimulado } from './similitud.ts'

// Proveedor OpenAI-compatible simulado como fetch inyectable. Registra cada
// llamada para comprobar, por ejemplo, que sin evidencia no se pide redacción.
export interface ProveedorSimulado {
  fetch: typeof fetch
  llamadas: { ruta: string; cuerpo: Record<string, unknown> }[]
  // Respuesta del chat: por defecto cita la primera sección del contexto.
  chat: (contenidoUsuario: string) => unknown
  embeddings: (textos: string[]) => unknown
  // Hace fallar con 500 una de las dos rutas.
  fallar: null | 'chat' | 'embeddings'
}

export function crearProveedorSimulado(): ProveedorSimulado {
  const simulado: ProveedorSimulado = {
    llamadas: [],
    fallar: null,
    chat: () => ({ respuesta: 'Según la sección [1], el procedimiento está documentado.', puntos_clave: [{ texto: 'Ver la sección 1.', fuentes: [1] }], vacios_de_cobertura: [], contradicciones: [] }),
    embeddings: textos => ({ data: textos.map((texto, index) => ({ index, embedding: vectorSimulado(texto) })) }),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const ruta = new URL(String(input)).pathname.replace(/^.*\/(embeddings|chat\/completions)$/, '/$1')
      const cuerpo = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      simulado.llamadas.push({ ruta, cuerpo })
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      if ((simulado.fallar === 'embeddings' && ruta === '/embeddings') || (simulado.fallar === 'chat' && ruta === '/chat/completions')) {
        return Response.json({ error: { message: 'fallo simulado' } }, { status: 500 })
      }
      if (ruta === '/embeddings') return Response.json(simulado.embeddings(cuerpo.input as string[]))
      const mensajes = cuerpo.messages as { role: string; content: string }[]
      const salida = simulado.chat(mensajes.find(mensaje => mensaje.role === 'user')?.content ?? '')
      return Response.json({ choices: [{ message: { content: JSON.stringify(salida) } }] })
    }) as typeof fetch,
  }
  return simulado
}
