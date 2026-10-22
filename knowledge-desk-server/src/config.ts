import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Knowledge Desk trabaja siempre sobre UN corpus. El modo decide dónde vive:
//  - forusguide: las consultas van al endpoint knowledge-question de ForUsGuide y
//    los documentos se indexan en el mismo índice Pinecone que ese backend lee.
//  - local: índice vectorial propio y un proveedor OpenAI-compatible para
//    embeddings y redacción.
//  - sin_configurar: el servidor arranca, pero informa que no puede consultar ni
//    indexar. Nunca inventa respuestas ni estados.
export type Modo = 'forusguide' | 'local' | 'sin_configurar'

export interface ForUsGuideConfig { url: string; apiKey: string | null }
export interface PineconeConfig { apiKey: string; indexHost: string; namespace: string }
export interface ProveedorConfig { baseUrl: string; apiKey: string | null; embeddingModel: string; chatModel: string }

export interface Config {
  host: string
  port: number
  dataDir: string
  uiDistDir: string | null
  modo: Modo
  consultaTimeoutMs: number
  forusguide: ForUsGuideConfig | null
  pinecone: PineconeConfig | null
  proveedor: ProveedorConfig | null
  cobertura: { minScore: number; altaScore: number; mediaScore: number }
  localTopK: number
  maxUploadBytes: number
  demoSimulado: boolean
  operador: string
  identityHeader: string | null
  proxySecreto: string | null
  accesoBasico: { usuario: string; clave: string }[]
  operadores: string[]
  contactoUrl: string | null
  verificacionIndiceMs: number
  verificacionIntervaloMs: number
  ejemplosArchivo: string
}

export const TIMEOUT_MIN_MS = 30_000
export const TIMEOUT_MAX_MS = 120_000
export const TIMEOUT_DEFECTO_MS = 90_000
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = path.resolve(serverRoot, '..')

export class ConfigError extends Error {}

function texto(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim()
  return value ? value : null
}

function url(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = texto(env, name)
  if (!value) return null
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new ConfigError(`${name} no es una URL válida`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ConfigError(`${name} debe usar http o https`)
  return value.replace(/\/+$/, '')
}

function numero(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = texto(env, name)
  if (value === null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new ConfigError(`${name} debe ser numérico`)
  return parsed
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const modoRaw = texto(env, 'KD_MODO')
  if (modoRaw && !['forusguide', 'local'].includes(modoRaw)) throw new ConfigError('KD_MODO debe ser forusguide o local')
  const modo: Modo = (modoRaw as Modo | null) ?? 'sin_configurar'

  const forusguideUrl = url(env, 'FORUSGUIDE_API_URL')
  const pineconeKey = texto(env, 'PINECONE_API_KEY')
  const pineconeHost = url(env, 'PINECONE_INDEX_HOST')
  const proveedorUrl = url(env, 'KD_LLM_BASE_URL')

  // El tiempo de espera se acota a un rango propuesto (HU01): por debajo de 30 s
  // una síntesis real se corta a menudo y por encima de 120 s la espera deja de
  // ser útil para quien consulta.
  const timeout = numero(env, 'KD_CONSULTA_TIMEOUT_MS', TIMEOUT_DEFECTO_MS)
  const consultaTimeoutMs = Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, timeout))

  const contacto = texto(env, 'KD_CONTACTO_URL')
  if (contacto && !/^(mailto:|https:\/\/)/i.test(contacto)) throw new ConfigError('KD_CONTACTO_URL debe empezar por mailto: o https://')

  const uiDist = texto(env, 'KD_UI_DIST') ?? path.join(projectRoot, 'knowledge-desk-ui', 'dist')

  // Acceso de piloto sin sistema de usuarios: pares usuario:clave en una variable
  // del servidor. Nunca llegan al navegador ni a un archivo del repositorio.
  const accesoBasico = (texto(env, 'KD_ACCESO_BASICO') ?? '').split(',').map(par => par.trim()).filter(Boolean).map(par => {
    const separador = par.indexOf(':')
    if (separador < 1 || separador === par.length - 1) throw new ConfigError('KD_ACCESO_BASICO debe tener el formato usuario:clave[,usuario:clave]')
    const credencial = { usuario: par.slice(0, separador), clave: par.slice(separador + 1) }
    if (!/^[\w.@+-]{1,120}$/.test(credencial.usuario)) throw new ConfigError('Un usuario de KD_ACCESO_BASICO tiene caracteres no válidos')
    if (credencial.clave.length < 12) throw new ConfigError('Cada clave de KD_ACCESO_BASICO debe tener al menos 12 caracteres')
    return credencial
  })
  const identityHeader = texto(env, 'KD_IDENTIDAD_HEADER')?.toLowerCase() ?? null
  const proxySecreto = texto(env, 'KD_PROXY_SECRETO')
  if (identityHeader && (!proxySecreto || proxySecreto.length < 24)) {
    throw new ConfigError('KD_IDENTIDAD_HEADER solo se acepta junto a KD_PROXY_SECRETO (24+ caracteres) que envía el proxy de identidad validado')
  }

  const host = texto(env, 'KD_HOST') ?? (env.RENDER ? '0.0.0.0' : '127.0.0.1')
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host)
  // Fuera de localhost la API administra documentos y consulta con credenciales
  // del servidor: no se publica sin control de acceso.
  if (!loopback && !accesoBasico.length && !identityHeader) {
    throw new ConfigError(`Exponer Knowledge Desk en ${host} exige KD_ACCESO_BASICO o un proxy de identidad (KD_IDENTIDAD_HEADER + KD_PROXY_SECRETO)`)
  }

  return {
    host,
    port: numero(env, 'KD_PORT', numero(env, 'PORT', 8787)),
    dataDir: path.resolve(texto(env, 'KD_DATA_DIR') ?? path.join(projectRoot, 'data')),
    uiDistDir: existsSync(path.join(uiDist, 'index.html')) ? uiDist : null,
    modo,
    consultaTimeoutMs,
    forusguide: modo === 'forusguide' && forusguideUrl ? { url: forusguideUrl, apiKey: texto(env, 'FORUSGUIDE_API_KEY') } : null,
    pinecone: modo === 'forusguide' && pineconeKey && pineconeHost
      ? { apiKey: pineconeKey, indexHost: pineconeHost, namespace: texto(env, 'PINECONE_NAMESPACE') ?? 'kb_articles' }
      : null,
    proveedor: modo === 'local' && proveedorUrl
      ? {
          baseUrl: proveedorUrl,
          apiKey: texto(env, 'KD_LLM_API_KEY'),
          embeddingModel: texto(env, 'KD_EMBEDDINGS_MODEL') ?? '',
          chatModel: texto(env, 'KD_CHAT_MODEL') ?? '',
        }
      : null,
    cobertura: {
      minScore: numero(env, 'KD_COBERTURA_MIN', 0.2),
      altaScore: numero(env, 'KD_COBERTURA_ALTA', 0.35),
      mediaScore: numero(env, 'KD_COBERTURA_MEDIA', 0.22),
    },
    localTopK: numero(env, 'KD_LOCAL_TOP_K', 8),
    maxUploadBytes: Math.round(Math.min(200, Math.max(1, numero(env, 'KD_MAX_ARTICULO_MB', 50))) * 1024 * 1024),
    demoSimulado: env.KD_DEMO_SIMULADO === 'true',
    operador: texto(env, 'KD_OPERADOR') ?? 'operador.tecnico',
    identityHeader,
    proxySecreto,
    accesoBasico,
    operadores: (texto(env, 'KD_OPERADORES') ?? '').split(',').map(item => item.trim()).filter(Boolean),
    contactoUrl: contacto,
    verificacionIndiceMs: numero(env, 'KD_VERIFICACION_INDICE_MS', 60_000),
    verificacionIntervaloMs: numero(env, 'KD_VERIFICACION_INTERVALO_MS', 1_000),
    ejemplosArchivo: path.resolve(texto(env, 'KD_EJEMPLOS_ARCHIVO') ?? path.join(projectRoot, 'config', 'ejemplos.json')),
  }
}

// Qué puede hacer realmente el servidor con la configuración recibida. Se expone
// a la interfaz sin valores secretos.
export function capacidades(config: Config) {
  const consulta = config.modo === 'forusguide'
    ? config.forusguide !== null
    : config.modo === 'local' && config.proveedor !== null && Boolean(config.proveedor.chatModel) && Boolean(config.proveedor.embeddingModel)
  const indexacion = config.modo === 'forusguide'
    ? config.pinecone !== null
    : config.modo === 'local' && config.proveedor !== null && Boolean(config.proveedor.embeddingModel)
  const faltan: string[] = []
  if (config.modo === 'sin_configurar') faltan.push('KD_MODO')
  if (config.modo === 'forusguide') {
    if (!config.forusguide) faltan.push('FORUSGUIDE_API_URL')
    if (!config.pinecone) faltan.push('PINECONE_API_KEY', 'PINECONE_INDEX_HOST')
  }
  if (config.modo === 'local') {
    if (!config.proveedor) faltan.push('KD_LLM_BASE_URL')
    if (!config.proveedor?.embeddingModel) faltan.push('KD_EMBEDDINGS_MODEL')
    if (!config.proveedor?.chatModel) faltan.push('KD_CHAT_MODEL')
  }
  return { consulta, indexacion, faltan }
}
