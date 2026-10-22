import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { similitud } from './similitud.ts'

// Simulador local del plano de datos de Pinecone con las rutas exactas que usa
// el SDK oficial (upsert NDJSON, list, delete y search). Permite inyectar
// fallos y retraso de visibilidad (consistencia eventual) para probar rollback,
// fallo parcial y verificación antes de publicar.
export interface Registro { _id: string; content: string; [campo: string]: unknown }

export interface Fallos {
  // Falla con 500 cualquier upsert que contenga un ID con este prefijo.
  upsertFalla?: string | null
  // IDs que el borrado ignora: simula embeddings que quedan en el índice.
  borradoDeja?: number
  // Registros nuevos que el listado tarda en mostrar (ms).
  retrasoVisibilidadMs?: number
  // Responde 503 a todo.
  caido?: boolean
}

export interface PineconeSimulado {
  url: string
  apiKeys: string[]
  registros: Map<string, Registro & { visibleDesde: number }>
  fallos: Fallos
  peticiones: { metodo: string; ruta: string }[]
  cerrar(): Promise<void>
}

async function cuerpo(request: IncomingMessage): Promise<string> {
  const partes: Buffer[] = []
  for await (const parte of request) partes.push(parte as Buffer)
  return Buffer.concat(partes).toString('utf8')
}

function cumpleFiltro(registro: Registro, filtro: Record<string, Record<string, unknown>> | undefined): boolean {
  if (!filtro) return true
  for (const [campo, condicion] of Object.entries(filtro)) {
    const valor = registro[campo]
    if ('$eq' in condicion && valor !== condicion.$eq) return false
    if ('$nin' in condicion && (condicion.$nin as unknown[]).includes(valor)) return false
    if ('$in' in condicion && !(condicion.$in as unknown[]).includes(valor)) return false
  }
  return true
}

export async function iniciarPineconeSimulado(puerto = 0): Promise<PineconeSimulado> {
  const estado: Omit<PineconeSimulado, 'url' | 'cerrar'> = { apiKeys: [], registros: new Map(), fallos: {}, peticiones: [] }
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    estado.peticiones.push({ metodo: request.method ?? '', ruta: url.pathname })
    const responder = (status: number, datos: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(datos))
    }
    estado.apiKeys.push(String(request.headers['api-key'] ?? ''))
    if (url.pathname === '/__control' && request.method === 'POST') {
      Object.assign(estado.fallos, JSON.parse(await cuerpo(request) || '{}'))
      return responder(200, { fallos: estado.fallos })
    }
    if (url.pathname === '/__registros') return responder(200, { ids: [...estado.registros.keys()] })
    if (estado.fallos.caido) return responder(503, { error: { code: 'UNAVAILABLE', message: 'simulado' } })
    const ahora = Date.now()

    if (request.method === 'POST' && /^\/records\/namespaces\/[^/]+\/upsert$/.test(url.pathname)) {
      const lineas = (await cuerpo(request)).split('\n').filter(Boolean).map(linea => JSON.parse(linea) as Registro)
      if (estado.fallos.upsertFalla && lineas.some(registro => registro._id.startsWith(estado.fallos.upsertFalla!))) {
        return responder(500, { error: { code: 'INTERNAL', message: 'fallo simulado de upsert' } })
      }
      for (const registro of lineas) estado.registros.set(registro._id, { ...registro, visibleDesde: ahora + (estado.fallos.retrasoVisibilidadMs ?? 0) })
      response.writeHead(201)
      return response.end()
    }

    if (request.method === 'GET' && url.pathname === '/vectors/list') {
      const prefijo = url.searchParams.get('prefix') ?? ''
      const limite = Number(url.searchParams.get('limit') ?? 100)
      const desde = Number(url.searchParams.get('paginationToken') ?? 0)
      const ids = [...estado.registros.values()].filter(registro => registro._id.startsWith(prefijo) && registro.visibleDesde <= ahora).map(registro => registro._id).sort()
      const pagina = ids.slice(desde, desde + limite)
      const siguiente = desde + limite < ids.length ? String(desde + limite) : undefined
      return responder(200, { vectors: pagina.map(id => ({ id })), pagination: siguiente ? { next: siguiente } : {}, namespace: 'simulado', usage: { readUnits: 1 } })
    }

    if (request.method === 'POST' && url.pathname === '/vectors/delete') {
      const { ids } = JSON.parse(await cuerpo(request)) as { ids: string[] }
      // Los que quedan son registros que EXISTEN: pedir borrar un ID inexistente
      // no cuenta como embedding residual.
      const existentes = ids.filter(id => estado.registros.has(id))
      const deja = estado.fallos.borradoDeja ?? 0
      existentes.slice(0, Math.max(0, existentes.length - deja)).forEach(id => estado.registros.delete(id))
      return responder(200, {})
    }

    if (request.method === 'POST' && /^\/records\/namespaces\/[^/]+\/search$/.test(url.pathname)) {
      const { query } = JSON.parse(await cuerpo(request)) as { query: { top_k: number; inputs: { text: string }; filter?: Record<string, Record<string, unknown>> } }
      const hits = [...estado.registros.values()]
        .filter(registro => registro.visibleDesde <= ahora && cumpleFiltro(registro, query.filter))
        .map(registro => ({ registro, score: similitud(query.inputs.text, registro.content) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, query.top_k)
        .map(({ registro, score }) => {
          const { _id, visibleDesde: _visible, ...fields } = registro
          return { _id, _score: Number(score.toFixed(4)), fields }
        })
      return responder(200, { result: { hits }, usage: { readUnits: 1, embedTotalTokens: 1 } })
    }

    responder(404, { error: { code: 'NOT_FOUND', message: `ruta simulada desconocida ${url.pathname}` } })
  })
  await new Promise<void>(resolve => server.listen(puerto, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    ...estado,
    url: `http://127.0.0.1:${port}`,
    cerrar: () => new Promise(resolve => server.close(() => resolve())),
  } as PineconeSimulado
}
