// Artículos kb_article_v2 SINTÉTICOS para pruebas y demostración. Siguen el
// esquema de los artículos de ForUsGuide ({ metadata, details }) y sus
// variantes, pero no reproducen ningún artículo real del corpus.
export type Datos = Record<string, unknown>

export function articulo(id: string, titulo: string, details: Datos, metadata: Datos = {}): Datos {
  return {
    metadata: {
      article_id: id,
      title: titulo,
      description: null,
      audience: 'Colaboradores',
      scope: 'internal',
      record_keeper: null,
      plan_type: null,
      tags: [],
      language: 'es',
      last_updated: '2026-03-02',
      schema_version: 'kb_article_v2',
      topic: null,
      subtopics: [],
      ...metadata,
    },
    details,
  }
}

// Bytes del archivo tal como se cargaría: JSON con sangría y salto final.
export const json = (valor: unknown, sangria: number | string = 2) => Buffer.from(`${JSON.stringify(valor, null, sangria)}\n`, 'utf8')

// Un artículo pequeño pero útil, con un paso por cada texto recibido.
export function articuloSimple(id: string, titulo: string, ...pasos: string[]): Datos {
  return articulo(id, titulo, {
    steps: pasos.map((description, indice) => ({ step_number: indice + 1, type: 'action', visibility: 'participant', description, notes: null })),
  })
}
