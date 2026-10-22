import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { capacidades, type Config } from './config.ts'
import { crearMotorForUsGuide } from './consulta/forusguide.ts'
import { crearMotorLocal } from './consulta/local.ts'
import type { Motor } from './consulta/motor.ts'
import { consultar } from './consulta/service.ts'
import { MAX_PREGUNTA, MIN_PREGUNTA } from './consulta/validate.ts'
import { GestorDocumentos, type ArchivoRecibido, type Log } from './documents/pipeline.ts'
import { PATRON_DOCUMENTO, PATRON_VERSION, Registro, type Documento } from './documents/store.ts'
import { KdError, cuerpoError } from './errors.ts'
import { Ejemplos, type Verificador } from './examples.ts'
import { esArticuloKd, requestId } from './ids.ts'
import { crearIndiceLocal, type IndiceLocal } from './index/local.ts'
import { crearIndicePinecone } from './index/pinecone.ts'
import type { IndiceCorpus } from './index/types.ts'
import { crearProveedor } from './providers/openaiCompatible.ts'

type FetchImpl = typeof fetch

export interface Servicios {
  config: Config
  registro: Registro
  gestor: GestorDocumentos
  motor: Motor | null
  indice: IndiceCorpus | null
  ejemplos: Ejemplos
}

export interface Inyecciones {
  fetchForUsGuide?: FetchImpl
  fetchPinecone?: FetchImpl
  fetchProveedor?: FetchImpl
  pineconeMaxRetries?: number
  ahora?: () => Date
  log?: Log
}

export async function construirServicios(config: Config, inyecciones: Inyecciones = {}): Promise<Servicios> {
  const registro = new Registro(config.dataDir)
  await registro.cargar()

  const proveedor = config.proveedor ? crearProveedor(config.proveedor, inyecciones.fetchProveedor) : null
  let indice: IndiceCorpus | null = null
  let indiceLocal: IndiceLocal | null = null
  if (config.modo === 'forusguide' && config.pinecone) {
    indice = crearIndicePinecone(config.pinecone, { fetchApi: inyecciones.fetchPinecone, maxRetries: inyecciones.pineconeMaxRetries })
  } else if (config.modo === 'local' && proveedor && config.proveedor?.embeddingModel) {
    indiceLocal = crearIndiceLocal(config.dataDir, proveedor)
    indice = indiceLocal
  }

  let motor: Motor | null = null
  if (config.modo === 'forusguide' && config.forusguide) {
    motor = crearMotorForUsGuide(config.forusguide, inyecciones.fetchForUsGuide)
  } else if (config.modo === 'local' && proveedor && indiceLocal && config.proveedor?.chatModel) {
    motor = crearMotorLocal({
      proveedor, indice: indiceLocal, umbrales: config.cobertura, topK: config.localTopK,
      servible: articulo => registro.articuloServible(articulo),
    })
  }

  const gestor = new GestorDocumentos(registro, indice, config, { ahora: inyecciones.ahora, log: inyecciones.log })
  await gestor.recuperar()

  // Un ejemplo solo se muestra si el corpus activo tiene evidencia para él. En
  // Pinecone se excluyen antes del corte las versiones que no pueden sustentar.
  let verificador: Verificador | null = null
  if (indice) {
    const actual = indice
    verificador = async pregunta => {
      const hits = await actual.buscar(pregunta, 5, { excluirArticulos: registro.articulosNoServibles(), signal: AbortSignal.timeout(15_000) })
      return hits.some(hit => {
        const articulo = String(hit.metadata.article_id ?? '')
        return hit.score >= config.cobertura.minScore && (!esArticuloKd(articulo) || registro.articuloServible(articulo))
      })
    }
  }
  const ejemplos = new Ejemplos(config.ejemplosArchivo, config.modo, verificador)
  return { config, registro, gestor, motor, indice, ejemplos }
}

const ESTADO_PUBLICO: Record<Documento['estado'], string> = {
  procesando: 'procesando', indexado: 'indexado', error: 'error', eliminando: 'eliminando', bloqueado: 'bloqueado', retirado: 'retirado',
}

function documentoPublico(doc: Documento, servicios: Servicios) {
  const activa = doc.versiones.find(version => version.version === doc.versionActiva) ?? null
  const ultima = doc.versiones[doc.versiones.length - 1]
  const op = doc.operacionEnCurso ? servicios.registro.operacion(doc.operacionEnCurso) : null
  return {
    id: doc.id,
    nombre: doc.nombre,
    estado: ESTADO_PUBLICO[doc.estado],
    fechaCarga: (activa ?? ultima).cargadoEn,
    fragmentos: activa?.fragmentos ?? null,
    versionActiva: doc.versionActiva,
    tipo: (activa ?? ultima).archivo.tipo,
    bytes: (activa ?? ultima).archivo.bytes,
    articuloId: (activa ?? ultima).articulo.id,
    titulo: (activa ?? ultima).articulo.titulo,
    error: doc.error,
    operacionEnCurso: op ? { id: op.id, tipo: op.tipo, version: op.version } : null,
    creadoEn: doc.creadoEn,
  }
}

function idDocumento(valor: string): string {
  if (!PATRON_DOCUMENTO.test(valor)) throw new KdError('NOT_FOUND', 'El documento no existe.')
  return valor
}

const ARTICULO = /^[A-Za-z0-9_.:-]{1,200}$/

// Archivos que solo pueden venir de dist: si no existen, son 404 y no la interfaz.
const RECURSO_ESTATICO = /\.(?:js|mjs|css|map|json|txt|ico|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|otf|webmanifest|html)$/i

// ¿Debe responder la interfaz (index.html) a esta ruta desconocida? Solo un GET
// o HEAD a una ruta de navegación: nunca la API (con o sin barra final) ni un
// recurso estático que no existe.
export function esRutaDeInterfaz(metodo: string, url: string): boolean {
  if (metodo !== 'GET' && metodo !== 'HEAD') return false
  const ruta = url.split('?')[0]
  if (ruta === '/api' || ruta.startsWith('/api/')) return false
  if (ruta.startsWith('/assets/')) return false
  return !RECURSO_ESTATICO.test(ruta)
}

function iguales(a: string, b: string): boolean {
  const resumenA = createHash('sha256').update(a).digest()
  const resumenB = createHash('sha256').update(b).digest()
  return timingSafeEqual(resumenA, resumenB)
}

export async function construirApp(servicios: Servicios, opciones: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const { config, registro, gestor } = servicios
  const app = Fastify({
    bodyLimit: 64 * 1024,
    genReqId: req => requestId(req.headers['x-request-id']),
    // Las URL de /resultados llevan la pregunta en la query: el registro de
    // accesos solo guarda la ruta.
    logger: opciones.logger === false ? false : {
      level: 'info',
      serializers: { req: req => ({ method: req.method, url: req.url.split('?')[0], id: req.id }) },
    },
  })

  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1, fields: 4, parts: 5 } })

  app.addHook('onSend', async (request, reply, carga) => {
    reply.header('x-request-id', request.id)
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'same-origin')
    if (String(reply.getHeader('content-type') ?? '').startsWith('text/html')) {
      reply.header('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'")
    }
    return carga
  })

  // Acceso interno sin sistema propio de usuarios ni roles:
  //  - KD_ACCESO_BASICO: credenciales de piloto (HTTP Basic sobre HTTPS).
  //  - Proxy de identidad corporativo: su cabecera solo se cree si llega junto
  //    al secreto compartido KD_PROXY_SECRETO. Desde Internet, sin ese secreto,
  //    la cabecera no autentica a nadie.
  //  - Sin ninguno, solo se puede escuchar en localhost (lo exige la config).
  const identidades = new WeakMap<FastifyRequest, string>()
  const exigeAcceso = config.accesoBasico.length > 0 || config.identityHeader !== null

  function identificar(request: FastifyRequest): string | null {
    if (config.identityHeader && config.proxySecreto) {
      const secreto = request.headers['x-kd-proxy-secreto']
      if (typeof secreto === 'string' && iguales(secreto, config.proxySecreto)) {
        const valor = request.headers[config.identityHeader]
        const identidad = Array.isArray(valor) ? valor[0] : valor
        if (identidad && /^[\w.@+-]{1,120}$/.test(identidad)) return identidad
      }
    }
    const autorizacion = request.headers.authorization
    if (config.accesoBasico.length && autorizacion?.startsWith('Basic ')) {
      const decodificado = Buffer.from(autorizacion.slice(6), 'base64').toString('utf8')
      const separador = decodificado.indexOf(':')
      const usuario = decodificado.slice(0, separador)
      const clave = decodificado.slice(separador + 1)
      // Se comparan todas las credenciales para no filtrar cuál existe por tiempo.
      let encontrado: string | null = null
      for (const credencial of config.accesoBasico) {
        if (iguales(usuario, credencial.usuario) && iguales(clave, credencial.clave)) encontrado = credencial.usuario
      }
      if (separador > 0 && encontrado) return encontrado
    }
    return exigeAcceso ? null : config.operador
  }

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/api/salud') return
    const identidad = identificar(request)
    if (identidad) {
      identidades.set(request, identidad)
      return
    }
    const error = new KdError('ACCESS_DENIED')
    if (config.accesoBasico.length) reply.header('www-authenticate', 'Basic realm="Knowledge Desk", charset="UTF-8"')
    return reply.status(error.status).send(cuerpoError(error, request.id))
  })

  function operadorAutorizado(request: FastifyRequest): string {
    const operador = identidades.get(request) ?? config.operador
    if (config.operadores.length && !config.operadores.includes(operador)) throw new KdError('OPERATOR_REQUIRED')
    return operador
  }

  // Comprobación de vida para la plataforma de despliegue: sin datos ni secretos.
  app.get('/api/salud', async () => ({ status: 'ok' }))

  app.setErrorHandler((error: Error & { code?: string; statusCode?: number }, request, reply) => {
    let kd: KdError
    if (error instanceof KdError) kd = error
    else if (error.code === 'FST_REQ_FILE_TOO_LARGE') kd = new KdError('FILE_TOO_LARGE')
    else if (error.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE' || error.code === 'FST_FILES_LIMIT' || error.code === 'FST_PARTS_LIMIT') kd = new KdError('FILE_REQUIRED', 'Envía un único archivo en el campo "archivo".')
    else if (request.url.startsWith('/api/consulta') && (error.statusCode === 400 || error.statusCode === 413 || error.statusCode === 415)) {
      kd = new KdError('VALIDATION_ERROR', 'La pregunta no es válida: el cuerpo de la solicitud no tiene el formato esperado.', { motivo: 'formato' })
    } else if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      kd = new KdError('NOT_FOUND', 'La solicitud no es válida.')
    } else {
      request.log.error({ err: error.name }, 'error no controlado')
      kd = new KdError('INTERNAL_ERROR')
    }
    reply.status(kd.status).send(cuerpoError(kd, request.id))
  })

  async function leerArchivo(request: FastifyRequest): Promise<ArchivoRecibido> {
    if (!request.isMultipart()) throw new KdError('FILE_REQUIRED')
    const parte = await request.file()
    if (!parte) throw new KdError('FILE_REQUIRED')
    let contenido: Buffer
    try {
      contenido = await parte.toBuffer()
    } catch (error) {
      if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw new KdError('FILE_TOO_LARGE', `${parte.filename}: supera el límite de ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.`)
      throw error
    }
    return { nombre: parte.filename, contenido }
  }

  // --- Estado y ejemplos -----------------------------------------------------

  app.get('/api/estado', async request => {
    const puede = capacidades(config)
    const usuario = identidades.get(request) ?? config.operador
    return {
      modo: config.modo,
      consulta: { configurada: servicios.motor !== null, motor: servicios.motor?.nombre ?? null },
      indexacion: { configurada: servicios.indice !== null, destino: servicios.indice?.descripcion ?? null },
      faltan: puede.faltan,
      limites: { preguntaMin: MIN_PREGUNTA, preguntaMax: MAX_PREGUNTA, archivoMaxBytes: config.maxUploadBytes, formatos: ['json'], esquema: 'kb_article_v2' },
      // Solo el stack de demostración activa esta marca: la interfaz la muestra
      // para no presentar servicios simulados como reales.
      simulado: config.demoSimulado,
      // Vista previa con almacenamiento efímero: la interfaz avisa que los
      // artículos cargados no se conservan. Los servicios pueden ser reales.
      datosTemporales: config.datosTemporales,
      consultaTimeoutMs: config.consultaTimeoutMs,
      cobertura: { politica: 'kd-cobertura-v1', umbralRelevancia: config.cobertura.minScore },
      usuario,
      puedeAdministrar: !config.operadores.length || config.operadores.includes(usuario),
      accesoControlado: exigeAcceso,
      accesoPublico: config.accesoPublico,
      contactoUrl: config.contactoUrl,
      revisionCorpus: registro.revision,
      residuosPendientes: gestor.residuosPendientes(),
    }
  })

  app.get('/api/ejemplos', async () => servicios.ejemplos.obtener(registro.revision))

  // --- Consulta (HU01–HU05, HU10) -------------------------------------------

  app.post('/api/consulta', async (request, reply) => {
    const respuesta = await consultar({
      motor: servicios.motor, registro, umbrales: config.cobertura, timeoutMs: config.consultaTimeoutMs,
      alDetectarNoServibles: () => gestor.solicitarLimpieza(),
    }, request.body, request.id)
    reply.header('cache-control', 'no-store')
    return respuesta
  })

  // Fuente externa (artículo del corpus de ForUsGuide). ForUsGuide no expone el
  // archivo JSON original: lo que se devuelve son los fragmentos INDEXADOS de
  // ese artículo, tal como están en el índice, y la respuesta lo declara.
  // Los documentos propios se abren en /api/documentos/:id con su JSON original.
  app.get<{ Params: { articleId: string } }>('/api/fuentes/:articleId', async request => {
    const articleId = request.params.articleId
    if (!ARTICULO.test(articleId)) throw new KdError('SOURCE_NOT_AVAILABLE')
    if (esArticuloKd(articleId)) {
      const ubicado = registro.ubicarArticulo(articleId)
      if (!ubicado) throw new KdError('SOURCE_NOT_AVAILABLE')
      return { tipo: 'documento', documentoId: ubicado.documento.id, version: ubicado.version.version }
    }
    if (!servicios.motor?.articulo) throw new KdError('SOURCE_NOT_AVAILABLE', 'Este modo no tiene artículos externos que abrir.')
    const articulo = await servicios.motor.articulo(articleId, { requestId: request.id, signal: AbortSignal.timeout(30_000) })
    return { tipo: 'articulo_externo', origen: 'fragmentos_indexados', ...articulo }
  })

  // --- Documentos (HU07–HU09) -----------------------------------------------

  app.get('/api/documentos', async () => ({
    documentos: gestor.listar().map(doc => documentoPublico(doc, servicios)),
    indexacionConfigurada: gestor.indexacionConfigurada,
    revisionCorpus: registro.revision,
  }))

  app.get<{ Params: { id: string }; Querystring: { version?: string } }>('/api/documentos/:id', async request => {
    const doc = registro.documento(idDocumento(request.params.id))
    if (!doc) throw new KdError('NOT_FOUND', 'El documento no existe.')
    const pedida = request.query.version
    if (pedida !== undefined && !PATRON_VERSION.test(pedida)) throw new KdError('NOT_FOUND', 'La versión no existe.')
    const version = doc.versiones.find(item => item.version === (pedida ?? doc.versionActiva ?? doc.versiones[doc.versiones.length - 1].version))
    if (!version) throw new KdError('NOT_FOUND', 'La versión no existe.')
    const fragmentos = await registro.leerFragmentos(doc.id, version.version)
    const archivoDisponible = existsSync(registro.rutaArchivo(version.archivo.ruta))
    return {
      documento: documentoPublico(doc, servicios),
      version: {
        version: version.version,
        estado: version.estado,
        nombre: version.archivo.nombre,
        tipo: version.archivo.tipo,
        bytes: version.archivo.bytes,
        sha256: version.archivo.sha256,
        cargadoEn: version.cargadoEn,
        fragmentos: version.fragmentos,
        articulo: version.articulo,
        error: version.error,
        archivoUrl: archivoDisponible ? `/api/documentos/${doc.id}/archivo?version=${version.version}` : null,
      },
      fragmentos: fragmentos.map(item => ({ indice: item.indice, texto: item.texto, tipo: item.tipo, categoria: item.categoria, nivel: item.nivel, rutas: item.rutas, parte: item.parte })),
      versiones: doc.versiones.map(item => ({ version: item.version, estado: item.estado, nombre: item.archivo.nombre, cargadoEn: item.cargadoEn, fragmentos: item.fragmentos })),
      operaciones: registro.operacionesDe(doc.id).map(op => ({ id: op.id, tipo: op.tipo, resultado: op.resultado, inicio: op.inicio, fin: op.fin, version: op.version })),
    }
  })

  app.get<{ Params: { id: string }; Querystring: { version?: string; descargar?: string } }>('/api/documentos/:id/archivo', async (request, reply) => {
    const doc = registro.documento(idDocumento(request.params.id))
    const pedida = request.query.version ?? doc?.versionActiva ?? undefined
    if (!doc || !pedida || !PATRON_VERSION.test(pedida)) throw new KdError('NOT_FOUND', 'El archivo no existe.')
    const version = doc.versiones.find(item => item.version === pedida)
    if (!version) throw new KdError('NOT_FOUND', 'El archivo no existe.')
    const ruta = registro.rutaArchivo(version.archivo.ruta)
    if (!existsSync(ruta)) throw new KdError('NOT_FOUND', 'El original ya no está disponible (documento retirado).')
    // Los bytes exactos que se cargaron, sin reformatear: es el JSON auténtico
    // de esa versión, verificable con su SHA-256.
    const descargar = request.query.descargar === '1'
    const nombre = encodeURIComponent(version.archivo.nombre)
    reply.header('content-type', 'application/json; charset=utf-8')
    reply.header('x-content-sha256', version.archivo.sha256)
    reply.header('content-disposition', `${descargar ? 'attachment' : 'inline'}; filename*=UTF-8''${nombre}`)
    reply.header('cache-control', 'no-store')
    return reply.send(await readFile(ruta))
  })

  app.post('/api/documentos', async (request, reply) => {
    const operador = operadorAutorizado(request)
    const archivo = await leerArchivo(request)
    const { documento, operacion } = await gestor.cargar(archivo, operador)
    reply.status(202)
    return { documento: documentoPublico(documento, servicios), operacion }
  })

  app.post<{ Params: { id: string } }>('/api/documentos/:id/reemplazo', async (request, reply) => {
    const operador = operadorAutorizado(request)
    const id = idDocumento(request.params.id)
    const archivo = await leerArchivo(request)
    const { documento, operacion } = await gestor.reemplazar(id, archivo, operador)
    reply.status(202)
    return { documento: documentoPublico(documento, servicios), operacion }
  })

  app.post<{ Params: { id: string } }>('/api/documentos/:id/reintento', async (request, reply) => {
    const operador = operadorAutorizado(request)
    const { documento, operacion } = await gestor.reintentar(idDocumento(request.params.id), operador)
    reply.status(202)
    return { documento: documentoPublico(documento, servicios), operacion }
  })

  app.post<{ Params: { id: string }; Body: { confirmado?: unknown } }>('/api/documentos/:id/eliminacion', async request => {
    const operador = operadorAutorizado(request)
    const operacion = await gestor.eliminar(idDocumento(request.params.id), operador, request.body?.confirmado)
    return { operacion }
  })

  app.get<{ Params: { id: string } }>('/api/operaciones/:id', async request => {
    if (!/^OP-\d{4}-\d{4,6}$/.test(request.params.id)) throw new KdError('NOT_FOUND', 'La operación no existe.')
    const operacion = registro.operacion(request.params.id)
    if (!operacion) throw new KdError('NOT_FOUND', 'La operación no existe.')
    return { operacion }
  })

  // --- Interfaz compilada (despliegue de un solo origen) ---------------------

  if (config.uiDistDir) {
    // Lo que no es un archivo de dist cae en el manejador de abajo, que entrega
    // index.html para las rutas del router de la interfaz. La raíz se declara
    // aparte: el comodín de archivos estáticos la trataría como un directorio.
    await app.register(fastifyStatic, { root: config.uiDistDir, index: false })
    app.get('/', (_request, reply) => reply.type('text/html; charset=utf-8').sendFile('index.html'))
  }
  app.setNotFoundHandler((request, reply) => {
    if (!config.uiDistDir || !esRutaDeInterfaz(request.method, request.url)) {
      const error = new KdError('NOT_FOUND')
      return reply.status(error.status).send(cuerpoError(error, request.id))
    }
    return reply.type('text/html; charset=utf-8').sendFile('index.html')
  })

  return app
}
