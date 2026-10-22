import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { construirApp, construirServicios, type Servicios } from '../../src/app.ts'
import { loadConfig, type Config } from '../../src/config.ts'
import { iniciarForUsGuideSimulado, type ForUsGuideSimulado } from './forusguide-simulado.ts'
import { iniciarPineconeSimulado, type PineconeSimulado } from './pinecone-simulado.ts'

export const CLAVE_SERVIDOR = 'clave-sintetica-del-servidor-0123456789'
export const CLAVE_PINECONE = 'pinecone-sintetica-0123456789'

export interface Entorno {
  app: FastifyInstance
  servicios: Servicios
  config: Config
  pinecone: PineconeSimulado
  forusguide: ForUsGuideSimulado
  dataDir: string
  subir(nombre: string, contenido: Buffer, ruta?: string): Promise<Awaited<ReturnType<FastifyInstance['inject']>>>
  preguntar(pregunta: string): Promise<{ status: number; cuerpo: Record<string, unknown> & { [clave: string]: any } }>
  reiniciar(): Promise<void>
  cerrar(): Promise<void>
}

export function multipart(nombre: string, contenido: Buffer) {
  const limite = `----kd${randomBytes(6).toString('hex')}`
  const cabecera = `--${limite}\r\nContent-Disposition: form-data; name="archivo"; filename="${nombre}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  return {
    payload: Buffer.concat([Buffer.from(cabecera, 'utf8'), contenido, Buffer.from(`\r\n--${limite}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${limite}` },
  }
}

export async function crearEntorno(extra: Record<string, string> = {}, ejemplos: unknown = { forusguide: [] }): Promise<Entorno> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'kd-prueba-'))
  const pinecone = await iniciarPineconeSimulado()
  const forusguide = await iniciarForUsGuideSimulado({ pinecone, apiKey: CLAVE_SERVIDOR })
  const ejemplosArchivo = path.join(dataDir, 'ejemplos.json')
  await writeFile(ejemplosArchivo, JSON.stringify(ejemplos), 'utf8')
  const config = loadConfig({
    KD_MODO: 'forusguide',
    FORUSGUIDE_API_URL: forusguide.url,
    FORUSGUIDE_API_KEY: CLAVE_SERVIDOR,
    PINECONE_API_KEY: CLAVE_PINECONE,
    PINECONE_INDEX_HOST: pinecone.url,
    PINECONE_NAMESPACE: 'kb_prueba',
    KD_DATA_DIR: path.join(dataDir, 'datos'),
    KD_UI_DIST: path.join(dataDir, 'sin-ui'),
    KD_EJEMPLOS_ARCHIVO: ejemplosArchivo,
    KD_VERIFICACION_INDICE_MS: '1500',
    KD_VERIFICACION_INTERVALO_MS: '50',
    ...extra,
  })

  const entorno = { config, pinecone, forusguide, dataDir } as Entorno
  async function montar() {
    entorno.servicios = await construirServicios(config, { pineconeMaxRetries: 0 })
    entorno.app = await construirApp(entorno.servicios, { logger: false })
  }
  await montar()
  entorno.subir = (nombre, contenido, ruta = '/api/documentos') => entorno.app.inject({ method: 'POST', url: ruta, ...multipart(nombre, contenido) })
  entorno.preguntar = async pregunta => {
    const respuesta = await entorno.app.inject({ method: 'POST', url: '/api/consulta', payload: { question: pregunta } })
    return { status: respuesta.statusCode, cuerpo: respuesta.json() }
  }
  entorno.reiniciar = async () => {
    await entorno.servicios.gestor.esperarInactividad()
    await entorno.app.close()
    await montar()
  }
  entorno.cerrar = async () => {
    await entorno.servicios.gestor.esperarInactividad()
    await entorno.app.close()
    await pinecone.cerrar()
    await forusguide.cerrar()
    await rm(dataDir, { recursive: true, force: true })
  }
  return entorno
}

export function idsCon(pinecone: PineconeSimulado, prefijo: string): string[] {
  return [...pinecone.registros.keys()].filter(id => id.startsWith(prefijo))
}
