import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { construirApp, construirServicios, esRutaDeInterfaz } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'

// Despliegue de un solo origen (Render): el servidor sirve la interfaz compilada.
// Se usa un dist mínimo en un directorio temporal, no Vite.
const INDEX = '<!doctype html><title>Knowledge Desk</title><div id="root" data-prueba="spa"></div>'
const basico = (usuario: string, clave: string) => `Basic ${Buffer.from(`${usuario}:${clave}`).toString('base64')}`

async function crearDist(dir: string) {
  const dist = path.join(dir, 'dist')
  await mkdir(path.join(dist, 'assets'), { recursive: true })
  await writeFile(path.join(dist, 'index.html'), INDEX)
  await writeFile(path.join(dist, 'assets', 'app.js'), 'console.log("knowledge-desk")')
  return dist
}

describe('Producción · interfaz compilada en el mismo origen', () => {
  let dir: string
  let app: FastifyInstance
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kd-produccion-'))
    const config = loadConfig({ KD_DATA_DIR: path.join(dir, 'datos'), KD_UI_DIST: await crearDist(dir) })
    assert.ok(config.uiDistDir, 'el servidor detecta el dist')
    app = await construirApp(await construirServicios(config), { logger: false })
  })
  after(async () => {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('la raíz y las rutas del router devuelven la interfaz', async () => {
    for (const ruta of ['/', '/documentos', '/documentos/DOC-0001?version=1.0', '/resultados?q=%C2%BFQu%C3%A9%3F', '/fuentes/articulo.v2']) {
      const respuesta = await app.inject(ruta)
      assert.equal(respuesta.statusCode, 200, ruta)
      assert.match(String(respuesta.headers['content-type']), /^text\/html/, ruta)
      assert.match(respuesta.body, /data-prueba="spa"/, ruta)
      assert.ok(respuesta.headers['content-security-policy'], ruta)
    }
    assert.equal((await app.inject({ method: 'HEAD', url: '/' })).statusCode, 200)
  })

  it('los recursos de dist se sirven tal cual y los que no existen son 404, no la interfaz', async () => {
    const recurso = await app.inject('/assets/app.js')
    assert.equal(recurso.statusCode, 200)
    assert.match(recurso.body, /knowledge-desk/)
    for (const ruta of ['/assets/no-existe.js', '/favicon.ico', '/robots.txt', '/estilos.css']) {
      const respuesta = await app.inject(ruta)
      assert.equal(respuesta.statusCode, 404, ruta)
      assert.doesNotMatch(respuesta.body, /data-prueba="spa"/, ruta)
    }
  })

  it('la API nunca cae en la interfaz: /api, /api/ y rutas desconocidas son 404 JSON', async () => {
    for (const [metodo, ruta] of [['GET', '/api'], ['GET', '/api/'], ['GET', '/api/no-existe'], ['GET', '/api?x=1'], ['POST', '/documentos'], ['DELETE', '/']] as const) {
      const respuesta = await app.inject({ method: metodo, url: ruta })
      assert.equal(respuesta.statusCode, 404, `${metodo} ${ruta}`)
      assert.equal(respuesta.json().code, 'NOT_FOUND', `${metodo} ${ruta}`)
      assert.match(respuesta.json().request_id, /^req-[0-9a-f]{8}$/)
    }
  })

  it('clasifica qué rutas desconocidas son de la interfaz', () => {
    assert.equal(esRutaDeInterfaz('GET', '/documentos/DOC-0001'), true)
    assert.equal(esRutaDeInterfaz('HEAD', '/resultados?q=a.js'), true)
    assert.equal(esRutaDeInterfaz('GET', '/apiario'), true)
    assert.equal(esRutaDeInterfaz('GET', '/api'), false)
    assert.equal(esRutaDeInterfaz('GET', '/assets/x'), false)
    assert.equal(esRutaDeInterfaz('GET', '/logo.svg'), false)
    assert.equal(esRutaDeInterfaz('POST', '/documentos'), false)
  })
})

describe('Vista previa con datos temporales (KD_DATOS_TEMPORALES)', () => {
  it('solo "true" activa la marca, que /api/estado expone sin tocar el modo ni la demostración', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kd-preview-'))
    try {
      for (const [valor, esperado] of [[undefined, false], ['false', false], ['1', false], ['true', true]] as const) {
        const config = loadConfig({ KD_MODO: 'local', KD_DATA_DIR: path.join(dir, 'datos'), KD_UI_DIST: path.join(dir, 'sin-ui'), ...(valor === undefined ? {} : { KD_DATOS_TEMPORALES: valor }) })
        assert.equal(config.datosTemporales, esperado, String(valor))
        const app = await construirApp(await construirServicios(config), { logger: false })
        const estado = (await app.inject('/api/estado')).json()
        await app.close()
        assert.equal(estado.datosTemporales, esperado, String(valor))
        assert.equal(estado.simulado, false)
        assert.equal(estado.modo, 'local')
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('Producción · vista previa con acceso público explícito', () => {
  let dir: string
  let app: FastifyInstance
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kd-produccion-publica-'))
    const config = loadConfig({ RENDER: 'true', KD_ACCESO_PUBLICO: 'true', KD_DATA_DIR: path.join(dir, 'datos'), KD_UI_DIST: await crearDist(dir) })
    app = await construirApp(await construirServicios(config), { logger: false })
  })
  after(async () => {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('sin credenciales la interfaz y la API responden sin pedir autenticación', async () => {
    for (const ruta of ['/', '/documentos', '/documentos/DOC-0001?version=1.0', '/assets/app.js']) {
      const respuesta = await app.inject(ruta)
      assert.equal(respuesta.statusCode, 200, ruta)
      assert.equal(respuesta.headers['www-authenticate'], undefined, ruta)
    }
    const estado = (await app.inject('/api/estado')).json()
    assert.equal(estado.accesoControlado, false)
    assert.equal(estado.puedeAdministrar, true)
    assert.equal((await app.inject('/api/no-existe')).statusCode, 404)
  })
})

describe('Producción · la interfaz compilada también exige acceso', () => {
  let dir: string
  let app: FastifyInstance
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kd-produccion-acceso-'))
    const config = loadConfig({
      KD_HOST: '0.0.0.0', KD_ACCESO_BASICO: 'piloto:clave-de-piloto-sintetica',
      KD_DATA_DIR: path.join(dir, 'datos'), KD_UI_DIST: await crearDist(dir),
    })
    app = await construirApp(await construirServicios(config), { logger: false })
  })
  after(async () => {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('sin credencial: raíz, rutas y recursos responden 401; la salud es pública', async () => {
    for (const ruta of ['/', '/documentos', '/assets/app.js', '/api/estado']) assert.equal((await app.inject(ruta)).statusCode, 401, ruta)
    assert.equal((await app.inject('/api/salud')).statusCode, 200)
  })

  it('con credencial: la raíz entrega la interfaz y la API sigue siendo JSON', async () => {
    const headers = { authorization: basico('piloto', 'clave-de-piloto-sintetica') }
    const raiz = await app.inject({ url: '/', headers })
    assert.equal(raiz.statusCode, 200)
    assert.match(raiz.body, /data-prueba="spa"/)
    const api = await app.inject({ url: '/api', headers })
    assert.equal(api.statusCode, 404)
    assert.equal(api.json().code, 'NOT_FOUND')
    assert.equal((await app.inject({ url: '/api/estado', headers })).statusCode, 200)
  })
})
