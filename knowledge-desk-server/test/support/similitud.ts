// Solo para simuladores de prueba. Aproxima la similitud entre textos con
// solapamiento de raíces de palabras y un pequeño diccionario de sinónimos. No
// es el motor del producto: en producción la similitud la calculan Pinecone
// (llama-text-embed-v2) o el proveedor de embeddings configurado.
const SINONIMOS: Record<string, string> = {
  devolucion: 'reembolso', reintegro: 'reembolso', reembolsar: 'reembolso', reembols: 'reembolso',
  gasto: 'viatico', gastos: 'viatico', viaje: 'viatico', viajes: 'viatico', viaticos: 'viatico',
  extranjero: 'internacional', internacionales: 'internacional', exterior: 'internacional',
  comprobante: 'factura', comprobantes: 'factura', facturas: 'factura', recibos: 'factura',
  plazo: 'plazo', dias: 'plazo',
}

const VACIAS = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'que', 'y', 'en', 'un', 'una', 'para', 'por', 'con', 'es', 'se', 'a', 'al', 'lo', 'su', 'sus', 'como', 'cual', 'cuál', 'qué', 'debo', 'mi', 'the', 'of', 'and', 'to'])

export function raices(texto: string): string[] {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(palabra => palabra.length > 2 && !VACIAS.has(palabra))
    .map(palabra => SINONIMOS[palabra] ?? SINONIMOS[palabra.slice(0, 8)] ?? palabra.slice(0, 7))
}

export function similitud(a: string, b: string): number {
  const ra = new Set(raices(a))
  const rb = new Set(raices(b))
  if (!ra.size || !rb.size) return 0
  let comunes = 0
  for (const raiz of ra) if (rb.has(raiz)) comunes++
  return comunes / Math.sqrt(ra.size * rb.size)
}

// Vector determinista a partir de las raíces (hashing trick). Con 256
// dimensiones las colisiones entre raíces no relacionadas son raras incluso en
// fragmentos largos; con 64, textos sin relación superaban el umbral por azar.
export function vectorSimulado(texto: string, dimension = 256): number[] {
  const vector = Array.from({ length: dimension }, () => 0)
  for (const raiz of raices(texto)) {
    let hash = 2166136261
    for (const caracter of raiz) hash = Math.imul(hash ^ caracter.charCodeAt(0), 16777619)
    vector[Math.abs(hash) % dimension] += 1
  }
  return vector
}
