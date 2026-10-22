import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { construirApp, construirServicios } from '../src/app.ts'
import { ConfigError, loadConfig } from '../src/config.ts'
import { articuloSimple, json } from './support/articulos.ts'
import { CLAVE_SERVIDOR, crearEntorno, multipart, type Entorno } from './support/entorno.ts'

const basico = (usuario: string, clave: string) => `Basic ${Buffer.from(`${usuario}:${clave}`).toString('base64')}`

describe('Despliegue: no se publica sin control de acceso', () => {
  it('fuera de localhost exige credenciales de piloto o un proxy de identidad', () => {
    assert.throws(() => loadConfig({ KD_HOST: '0.0.0.0' }), ConfigError)
    assert.throws(() => loadConfig({ RENDER: 'true' }), /exige KD_ACCESO_BASICO/)
    assert.throws(() => loadConfig({ KD_HOST: '0.0.0.0', KD_IDENTIDAD_HEADER: 'x-forwarded-email' }), /KD_PROXY_SECRETO/)
    assert.throws(() => loadConfig({ KD_HOST: '0.0.0.0', KD_ACCESO_BASICO: 'piloto:corta' }), /12 caracteres/)
    const config = loadConfig({ RENDER: 'true', PORT: '10000', KD_ACCESO_BASICO: 'piloto:clave-de-piloto-segura' })
    assert.equal(config.host, '0.0.0.0')
    assert.equal(config.port, 10000)
  })
})

describe('Acceso de piloto (HTTP Basic) y operadores autorizados', () => {
  let dir: string
  let app: FastifyInstance
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kd-acceso-'))
    const config = loadConfig({
      KD_HOST: '0.0.0.0',
      KD_ACCESO_BASICO: 'colaborador:clave-de-colaborador-1,operador.tecnico:clave-de-operador-12',
      KD_OPERADORES: 'operador.tecnico',
      KD_DATA_DIR: path.join(dir, 'datos'), KD_UI_DIST: path.join(dir, 'sin-ui'),
    })
    app = await construirApp(await construirServicios(config), { logger: false })
  })
  after(async () => {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('sin credenciales o con una errónea responde 401 y pide autenticación; la salud es pública', async () => {
    for (const authorization of [undefined, basico('colaborador', 'mala-clave-larga')]) {
      const respuesta = await app.inject({ url: '/api/estado', headers: authorization ? { authorization } : {} })
      assert.equal(respuesta.statusCode, 401)
      assert.match(String(respuesta.headers['www-authenticate']), /^Basic realm="Knowledge Desk"/)
    }
    assert.equal((await app.inject('/documentos')).statusCode, 401, 'también la interfaz')
    assert.deepEqual((await app.inject('/api/salud')).json(), { status: 'ok' })
  })

  it('un colaborador consulta pero no administra documentos; el operador sí', async () => {
    const estado = (await app.inject({ url: '/api/estado', headers: { authorization: basico('colaborador', 'clave-de-colaborador-1') } })).json()
    assert.equal(estado.usuario, 'colaborador')
    assert.equal(estado.puedeAdministrar, false)
    assert.doesNotMatch(JSON.stringify(estado), /clave-de/)
    const archivo = multipart('a.json', json(articuloSimple('a', 'A', 'Paso con texto suficiente para indexarse.')))
    const subida = await app.inject({ method: 'POST', url: '/api/documentos', headers: { authorization: basico('colaborador', 'clave-de-colaborador-1'), ...archivo.headers }, payload: archivo.payload })
    assert.equal(subida.statusCode, 403)
    assert.equal(subida.json().code, 'OPERATOR_REQUIRED')
    const operador = (await app.inject({ url: '/api/estado', headers: { authorization: basico('operador.tecnico', 'clave-de-operador-12') } })).json()
    assert.equal(operador.puedeAdministrar, true)
  })

  it('la cabecera de identidad no autentica a nadie si no llega desde el proxy validado', async () => {
    const respuesta = await app.inject({ url: '/api/estado', headers: { 'x-forwarded-email': 'operador.tecnico' } })
    assert.equal(respuesta.statusCode, 401)
  })
})

describe('Proxy de identidad con secreto compartido', () => {
  let entorno: Entorno
  const secreto = 'secreto-compartido-del-proxy-0123456789'
  before(async () => {
    entorno = await crearEntorno({ KD_IDENTIDAD_HEADER: 'x-forwarded-email', KD_PROXY_SECRETO: secreto, KD_OPERADORES: 'ana@empresa.test' })
  })
  after(async () => entorno.cerrar())

  it('solo con el secreto del proxy la identidad se usa como operador y queda en la auditoría', async () => {
    const sinSecreto = await entorno.app.inject({ url: '/api/estado', headers: { 'x-forwarded-email': 'ana@empresa.test' } })
    assert.equal(sinSecreto.statusCode, 401)
    const archivo = multipart('Procedimiento.json', json(articuloSimple('procedimiento_archivo', 'Procedimiento de archivo', 'Procedimiento de archivo con texto suficiente para indexar correctamente.')))
    const respuesta = await entorno.app.inject({
      method: 'POST', url: '/api/documentos', payload: archivo.payload,
      headers: { ...archivo.headers, 'x-forwarded-email': 'ana@empresa.test', 'x-kd-proxy-secreto': secreto },
    })
    assert.equal(respuesta.statusCode, 202)
    assert.equal(respuesta.json().operacion.operador, 'ana@empresa.test')
    assert.doesNotMatch(respuesta.body, new RegExp(`${secreto}|${CLAVE_SERVIDOR}`))
  })
})
