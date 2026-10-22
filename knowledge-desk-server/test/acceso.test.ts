import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { construirApp, construirServicios, type Servicios } from '../src/app.ts'
import { ConfigError, loadConfig } from '../src/config.ts'
import { articuloSimple, json } from './support/articulos.ts'
import { CLAVE_SERVIDOR, crearEntorno, multipart, type Entorno } from './support/entorno.ts'
import { crearProveedorSimulado } from './support/proveedor-simulado.ts'

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

  it('KD_ACCESO_PUBLICO: solo "true" abre el acceso, "false" mantiene la exigencia y otro valor se rechaza', () => {
    const publico = loadConfig({ RENDER: 'true', KD_ACCESO_PUBLICO: 'true' })
    assert.equal(publico.host, '0.0.0.0')
    assert.equal(publico.accesoPublico, true)
    assert.equal(publico.operador, 'Acceso público')
    assert.throws(() => loadConfig({ RENDER: 'true', KD_ACCESO_PUBLICO: 'false' }), /exige KD_ACCESO_BASICO/)
    assert.throws(() => loadConfig({ KD_HOST: '0.0.0.0', KD_ACCESO_PUBLICO: 'si' }), /KD_ACCESO_PUBLICO debe ser true o false/)
    assert.equal(loadConfig({}).accesoPublico, false)
  })

  it('el acceso público no se combina con credenciales, proxy ni operadores: el conflicto impide arrancar', () => {
    const casos: Record<string, string>[] = [
      { KD_ACCESO_BASICO: 'piloto:clave-de-piloto-segura' },
      { KD_IDENTIDAD_HEADER: 'x-forwarded-email', KD_PROXY_SECRETO: 'secreto-compartido-del-proxy-0123456789' },
      { KD_PROXY_SECRETO: 'secreto-compartido-del-proxy-0123456789' },
      { KD_OPERADORES: 'ialvisti' },
    ]
    for (const extra of casos) {
      assert.throws(() => loadConfig({ KD_HOST: '0.0.0.0', KD_ACCESO_PUBLICO: 'true', ...extra }), new RegExp(`no se combina con ${Object.keys(extra)[0]}`), Object.keys(extra).join())
    }
  })
})

describe('Localhost sin cambios', () => {
  it('sin configuración de acceso no pide credencial; con KD_ACCESO_BASICO la exige también en localhost', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kd-localhost-'))
    try {
      for (const [extra, esperado] of [[{}, 200], [{ KD_ACCESO_BASICO: 'piloto:clave-de-piloto-segura' }, 401]] as const) {
        const app = await construirApp(await construirServicios(loadConfig({ KD_DATA_DIR: path.join(dir, 'datos'), KD_UI_DIST: path.join(dir, 'sin-ui'), ...extra })), { logger: false })
        const estado = await app.inject('/api/estado')
        await app.close()
        assert.equal(estado.statusCode, esperado)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// Modo local con el proveedor simulado: con KD_MODO=forusguide el acceso público
// no admite escritura en el índice compartido (ver forusguide-solo-consulta.test.ts).
describe('Acceso público explícito (vista previa sin inicio de sesión)', () => {
  let dir: string
  let app: FastifyInstance
  let servicios: Servicios
  const subir = (nombre: string, contenido: Buffer, ruta = '/api/documentos') => app.inject({ method: 'POST', url: ruta, ...multipart(nombre, contenido) })
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kd-acceso-publico-'))
    const config = loadConfig({
      KD_MODO: 'local', KD_LLM_BASE_URL: 'http://proveedor.simulado/v1', KD_EMBEDDINGS_MODEL: 'emb-simulado', KD_CHAT_MODEL: 'chat-simulado',
      KD_HOST: '0.0.0.0', KD_ACCESO_PUBLICO: 'true', KD_DATA_DIR: path.join(dir, 'datos'), KD_UI_DIST: path.join(dir, 'sin-ui'),
      KD_VERIFICACION_INDICE_MS: '500', KD_VERIFICACION_INTERVALO_MS: '20',
    })
    servicios = await construirServicios(config, { fetchProveedor: crearProveedorSimulado().fetch })
    app = await construirApp(servicios, { logger: false })
  })
  after(async () => {
    await servicios.gestor.esperarInactividad()
    await app.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('el estado no exige acceso, permite administrar y ninguna cabecera cambia la identidad', async () => {
    for (const headers of [{}, { authorization: basico('alguien', 'clave-cualquiera-123') }, { 'x-forwarded-email': 'ana@empresa.test', 'x-kd-proxy-secreto': 'inventado' }]) {
      const respuesta = await app.inject({ url: '/api/estado', headers })
      assert.equal(respuesta.statusCode, 200)
      assert.equal(respuesta.headers['www-authenticate'], undefined)
      const estado = respuesta.json()
      assert.equal(estado.accesoControlado, false)
      assert.equal(estado.accesoPublico, true)
      assert.equal(estado.puedeAdministrar, true)
      assert.equal(estado.usuario, 'Acceso público')
      assert.equal(estado.consulta.configurada, true)
    }
  })

  it('sin credenciales: carga, original, consulta, reemplazo y eliminación funcionan y se registran como acceso público', async () => {
    const original = json(articuloSimple('acceso_publico_viaticos', 'Viáticos de prueba', 'El reembolso de viáticos internacionales se solicita en el portal de gastos dentro de los 15 días posteriores al viaje.'))
    const carga = await subir('Acceso_Publico.json', original)
    assert.equal(carga.statusCode, 202)
    assert.equal(carga.json().operacion.operador, 'Acceso público')
    await servicios.gestor.esperarInactividad()
    const id = carga.json().documento.id
    assert.equal(servicios.registro.documento(id)!.estado, 'indexado')

    const archivo = await app.inject(`/api/documentos/${id}/archivo?version=1.0`)
    assert.equal(archivo.statusCode, 200)
    assert.ok(archivo.rawPayload.equals(original))

    const consulta = await app.inject({ method: 'POST', url: '/api/consulta', payload: { question: '¿Cuál es el plazo del reembolso de viáticos internacionales?' } })
    assert.equal(consulta.statusCode, 200)
    assert.equal(consulta.json().outcome, 'answered')

    const reemplazo = await subir('Acceso_Publico_v2.json', original, `/api/documentos/${id}/reemplazo`)
    assert.equal(reemplazo.statusCode, 202)
    await servicios.gestor.esperarInactividad()
    const eliminacion = await app.inject({ method: 'POST', url: `/api/documentos/${id}/eliminacion`, payload: { confirmado: true } })
    assert.equal(eliminacion.statusCode, 200)
    assert.equal(eliminacion.json().operacion.resultado, 'exitoso')
    assert.equal(eliminacion.json().operacion.operador, 'Acceso público')
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
