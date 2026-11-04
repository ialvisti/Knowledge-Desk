import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { construirApp, construirServicios, type Servicios } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { clasificarBloque, extraerTexto, fragmentarTexto, segmentar } from '../src/documents/texto.ts'
import { crearIndicePinecone } from '../src/index/pinecone.ts'
import { IndiceError } from '../src/index/types.ts'
import { multipart } from './support/entorno.ts'
import { crearLlmSimulado, redacciones } from './support/llm-simulado.ts'
import { iniciarPineconeSimulado, type PineconeSimulado } from './support/pinecone-simulado.ts'

// HU07 con documentos de texto en el modo directo: PDF, DOCX y TXT reales
// (los mismos archivos de demostración que usa la interfaz) por la API
// multipart, extraídos y fragmentados en el SERVIDOR e indexados SOLO en el
// namespace de documentos de Knowledge Desk. Pinecone se simula con sus rutas
// reales; el LLM con un fetch que cuenta las llamadas.
const DEMO = fileURLToPath(new URL('../../demo/documentos-locales/', import.meta.url))
const NS_BASE = 'kb_articles'
const NS_DOCS = 'knowledge_desk_documents'
const MUTACION = /\/(upsert|delete)$|\/vectors\/list$/
// PNG real de 1×1 píxel.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

// Texto conocido con una sección por tipo de fragmento (kd-clasificacion-v1).
const TEXTO_CONOCIDO = `Guía de licencias del personal

Alcance
Esta guía ficticia resume las licencias del personal de Aula Ejemplo para una demostración académica.

Definiciones
Se entiende por licencia remunerada el permiso con goce de sueldo aprobado por el área de personas.

Requisitos
Pueden solicitar la licencia los colaboradores con contrato vigente y al menos seis meses de antigüedad.

Monto del auxilio
El auxilio de transporte durante la licencia es de 50000 COP por mes.

Reglas
La solicitud debe presentarse con un plazo mínimo de 10 días hábiles antes del inicio.

Procedimiento de solicitud
1. Completa el formulario de licencia en el portal interno.
2. Adjunta el soporte firmado por tu jefe directo.

Preguntas frecuentes
¿Puedo fraccionar la licencia?
Sí, en un máximo de dos periodos dentro del mismo año.
`

const sha256 = (datos: Buffer) => createHash('sha256').update(datos).digest('hex')

describe('HU07 · documentos PDF, DOCX y TXT en el servidor (modo directo)', () => {
  let dir: string
  let pinecone: PineconeSimulado
  let llm: ReturnType<typeof crearLlmSimulado>
  let servicios: Servicios
  let app: FastifyInstance

  before(async () => {
    pinecone = await iniciarPineconeSimulado()
  })
  beforeEach(async () => {
    await app?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = await mkdtemp(path.join(os.tmpdir(), 'kd-texto-'))
    await writeFile(path.join(dir, 'ejemplos.json'), JSON.stringify({ directo: [] }))
    pinecone.registros.clear()
    pinecone.peticiones.length = 0
    // Un registro del corpus base: nada de lo que hace Knowledge Desk puede tocarlo.
    pinecone.registros.set('base_articulo_chunk_1', { _id: 'base_articulo_chunk_1', content: 'Artículo del corpus base compartido.', article_id: 'base_articulo', visibleDesde: 0, __ns: NS_BASE })
    llm = crearLlmSimulado()
    const config = loadConfig({
      KD_MODO: 'directo', PINECONE_API_KEY: 'pinecone-sintetica-texto-0123456789', PINECONE_INDEX_HOST: pinecone.url, PINECONE_NAMESPACE: NS_BASE,
      KD_LLM_BASE_URL: 'http://llm.simulado/v1', KD_LLM_API_KEY: 'llm-sintetica-texto-0123456789', KD_CHAT_MODEL: 'gpt-simulado',
      KD_DATA_DIR: path.join(dir, 'datos'), KD_UI_DIST: path.join(dir, 'sin-ui'), KD_EJEMPLOS_ARCHIVO: path.join(dir, 'ejemplos.json'),
      KD_VERIFICACION_INDICE_MS: '1500', KD_VERIFICACION_INTERVALO_MS: '20',
    })
    servicios = await construirServicios(config, { fetchProveedor: llm.fetch, pineconeMaxRetries: 0 })
    app = await construirApp(servicios, { logger: false })
  })
  after(async () => {
    await app?.close()
    await pinecone.cerrar()
    await rm(dir, { recursive: true, force: true })
  })

  async function subir(nombre: string, contenido: Buffer) {
    const respuesta = await app.inject({ method: 'POST', url: '/api/documentos', ...multipart(nombre, contenido) })
    await servicios.gestor.esperarInactividad()
    return respuesta
  }
  const registrosKd = () => [...pinecone.registros.values()].filter(registro => registro.__ns === NS_DOCS)

  // CP-HU07-03
  for (const [archivo, formato, mime] of [
    ['politica-viaticos-v1.pdf', 'pdf', 'application/pdf'],
    ['politica-viaticos-v1.docx', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['politica-viaticos-v1.txt', 'txt', 'text/plain; charset=utf-8'],
  ] as const) {
    it(`CP-HU07-03 · ${formato.toUpperCase()} real: se acepta, se procesa y conserva archivo, texto y fragmentos asociados`, async () => {
      const original = await readFile(path.join(DEMO, archivo))
      const carga = await subir(archivo, original)
      assert.equal(carga.statusCode, 202)
      const docId: string = carga.json().documento.id

      const detalle = (await app.inject({ method: 'GET', url: `/api/documentos/${docId}` })).json()
      assert.equal(detalle.documento.estado, 'indexado')
      assert.equal(detalle.version.tipo, formato)
      assert.equal(detalle.version.sha256, sha256(original))
      assert.equal(detalle.version.articulo.id, `politica_viaticos_v1_${formato}`)
      assert.equal(detalle.version.articulo.titulo, 'Política de viáticos nacionales')

      // Archivo: los bytes exactos que se cargaron, con su tipo MIME.
      const bytes = await app.inject({ method: 'GET', url: detalle.version.archivoUrl })
      assert.equal(bytes.statusCode, 200)
      assert.ok(bytes.rawPayload.equals(original), 'el original se entrega byte a byte')
      assert.equal(bytes.headers['x-content-sha256'], sha256(original))
      assert.equal(bytes.headers['content-type'], mime)

      // Texto: lo extraído en el servidor, que contiene el contenido real.
      const texto = await app.inject({ method: 'GET', url: detalle.version.texto.url })
      assert.equal(texto.statusCode, 200)
      assert.match(texto.body, /120000 COP/)
      assert.match(texto.body, /5 días hábiles/)
      assert.equal(detalle.version.texto.caracteres, texto.body.length)

      // Fragmentos: texto literal del documento, con su origen y clasificación.
      const fragmentos = detalle.fragmentos as { indice: number; texto: string; tipo: string; rutas: string[] }[]
      assert.ok(fragmentos.length >= 5)
      const normalizado = texto.body.replace(/\s+/g, ' ')
      for (const fragmento of fragmentos) {
        const cuerpo = fragmento.texto.split('\n').slice(1).join(' ').replace(/\s+/g, ' ')
        assert.ok(normalizado.includes(cuerpo), `fragmento ${fragmento.indice} sale del texto extraído`)
        assert.ok(fragmento.rutas.every(ruta => /^bloques\[\d+\]$/.test(ruta)))
      }
      const porTipo = new Map(fragmentos.map(item => [item.texto.split('\n')[1].slice(0, 20), item.tipo]))
      assert.equal(porTipo.get('El auxilio diario de'), 'fees_details')
      assert.equal(porTipo.get('La legalización de v'), 'business_rules')

      // Embeddings: uno por fragmento, SOLO en el namespace de documentos y
      // asociados al documento y versión correctos.
      const kd = registrosKd()
      assert.equal(kd.length, fragmentos.length)
      for (const registro of kd) {
        assert.match(registro._id, new RegExp(`^kd_${docId.toLowerCase().replace('-', '')}_v1_0_chunk_\\d+$`))
        assert.equal(registro.kd_document_id, docId)
        assert.equal(registro.kd_format, formato)
        const fragmento = fragmentos.find(item => registro._id.endsWith(`_chunk_${item.indice}`))!
        assert.equal(registro.content, fragmento.texto)
        assert.equal(registro.chunk_type, fragmento.tipo)
      }
      const operacion = detalle.operaciones[0]
      assert.equal(operacion.resultado, 'exitoso')
      assert.ok(pinecone.peticiones.filter(item => MUTACION.test(item.ruta)).every(item => item.namespace === NS_DOCS))
      assert.equal(pinecone.registros.get('base_articulo_chunk_1')?.__ns, NS_BASE)
      assert.equal(llm.llamadas.length, 0, 'cargar no llama al LLM: los embeddings los genera Pinecone')
    })
  }

  // CP-HU07-04
  it('CP-HU07-04 · un PNG se rechaza con un mensaje claro, sin documento, fragmentos, embeddings ni LLM', async () => {
    const antes = (await app.inject({ method: 'GET', url: '/api/documentos' })).json().documentos.length
    for (const nombre of ['diagrama.png', 'disfrazado.pdf', 'disfrazado.txt']) {
      const respuesta = await subir(nombre, PNG)
      assert.equal(respuesta.statusCode, 415, nombre)
      const cuerpo = respuesta.json()
      assert.equal(cuerpo.code, 'UNSUPPORTED_FORMAT')
      assert.match(cuerpo.message, new RegExp(`^${nombre.replace('.', '\\.')}: `))
      assert.match(cuerpo.message, /PDF con texto, DOCX y TXT/)
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/documentos' })).json().documentos.length, antes)
    assert.equal(pinecone.peticiones.length, 0, 'ninguna petición a Pinecone')
    assert.equal(registrosKd().length, 0)
    assert.equal(llm.llamadas.length, 0)
    const datos = path.join(dir, 'datos')
    assert.ok(!existsSync(path.join(datos, 'archivos')) || (await readdir(path.join(datos, 'archivos'))).length === 0, 'no se guarda el archivo')
    assert.ok(!existsSync(path.join(datos, 'fragmentos')))
  })

  it('un PDF dañado, un DOCX que no es Word y un TXT sin texto útil se rechazan antes de registrar nada', async () => {
    for (const [nombre, contenido] of [
      ['roto.pdf', Buffer.from('%PDF-1.4\n%garbage sin objetos')],
      ['falso.docx', Buffer.from('PK\u0003\u0004 no es un zip válido')],
      ['vacio-util.txt', await readFile(path.join(DEMO, 'error-sin-texto.txt'))],
      ['binario.txt', Buffer.from([0x48, 0x6f, 0x6c, 0x61, 0x00, 0x01])],
    ] as const) {
      const respuesta = await subir(nombre, contenido)
      assert.equal(respuesta.statusCode, 422, nombre)
      assert.equal(respuesta.json().code, 'INVALID_DOCUMENT', nombre)
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/documentos' })).json().documentos.length, 0)
    assert.equal(pinecone.peticiones.length, 0)
  })

  // CP-HU07-06
  it('CP-HU07-06 · texto conocido: extracción, fragmentación, clasificación y embeddings del documento correcto', async () => {
    const original = Buffer.from(TEXTO_CONOCIDO, 'utf8')
    const carga = await subir('guia-licencias.txt', original)
    assert.equal(carga.statusCode, 202)
    const docId: string = carga.json().documento.id
    const detalle = (await app.inject({ method: 'GET', url: `/api/documentos/${docId}` })).json()
    assert.equal(detalle.documento.estado, 'indexado')

    // Todas las etapas, en orden y correctas.
    const operacion = (await app.inject({ method: 'GET', url: `/api/operaciones/${detalle.operaciones[0].id}` })).json().operacion
    assert.deepEqual(operacion.pasos.map((paso: { nombre: string }) => paso.nombre), ['validacion', 'lectura', 'fragmentacion', 'clasificacion', 'embeddings', 'verificacion', 'activacion'])
    assert.ok(operacion.pasos.every((paso: { estado: string }) => paso.estado === 'ok'))
    assert.match(operacion.pasos[3].detalle, /kd-clasificacion-v1/)

    // Extracción literal.
    const texto = (await app.inject({ method: 'GET', url: detalle.version.texto.url })).body
    assert.equal(texto, TEXTO_CONOCIDO.trim())

    // Fragmentación y clasificación esperadas para cada sección.
    const fragmentos = detalle.fragmentos as { indice: number; texto: string; tipo: string; categoria: string; nivel: string; rutas: string[] }[]
    assert.deepEqual(fragmentos.map(item => [item.categoria, item.tipo, item.nivel]), [
      ['Alcance', 'overview', 'low'],
      ['Definiciones', 'definitions', 'medium'],
      ['Requisitos', 'eligibility', 'high'],
      ['Monto del auxilio', 'fees_details', 'medium'],
      ['Reglas', 'business_rules', 'high'],
      ['Procedimiento de solicitud', 'steps', 'medium'],
      ['Preguntas frecuentes', 'faqs', 'medium'],
    ])
    const pasos = fragmentos.find(item => item.tipo === 'steps')!
    assert.equal(pasos.texto, 'Guía de licencias del personal — Procedimiento de solicitud\n1. Completa el formulario de licencia en el portal interno.\n2. Adjunta el soporte firmado por tu jefe directo.')
    assert.equal(pasos.rutas.length, 2)
    const faq = fragmentos.find(item => item.tipo === 'faqs')!
    assert.match(faq.texto, /¿Puedo fraccionar la licencia\?\nSí, en un máximo de dos periodos/)

    // Embeddings: uno por fragmento, con el mismo texto y tipo, del documento correcto.
    const kd = registrosKd()
    assert.equal(kd.length, fragmentos.length)
    assert.deepEqual(operacion.contadores.embeddings, { hechos: fragmentos.length, total: fragmentos.length })
    for (const fragmento of fragmentos) {
      const registro = pinecone.registros.get(`kd_${docId.toLowerCase().replace('-', '')}_v1_0_chunk_${fragmento.indice}`)!
      assert.equal(registro.__ns, NS_DOCS)
      assert.equal(registro.content, fragmento.texto)
      assert.equal(registro.chunk_type, fragmento.tipo)
      assert.equal(registro.kd_document_id, docId)
      assert.equal(registro.kd_file_name, 'guia-licencias.txt')
    }

    // El documento forma parte del corpus de consulta, como fuente propia.
    llm.subconsultas = []
    llm.redaccion = () => ({ respuesta: 'Pueden solicitar la licencia los colaboradores con contrato vigente y seis meses de antigüedad [1].', puntos_clave: [], vacios_de_cobertura: [], contradicciones: [] })
    const consulta = (await app.inject({ method: 'POST', url: '/api/consulta', payload: { question: '¿Quiénes pueden solicitar la licencia remunerada?' } })).json()
    assert.equal(consulta.outcome, 'answered')
    const fuente = consulta.sources.find((item: { kind: string }) => item.kind === 'document')
    assert.ok(fuente, 'el documento cargado aparece como fuente')
    assert.equal(fuente.document_id, docId)
    assert.equal(fuente.file_name, 'guia-licencias.txt')
    assert.equal(redacciones(llm.llamadas).length, 1)
    assert.ok(pinecone.peticiones.some(item => item.ruta === `/records/namespaces/${NS_BASE}/search`), 'también se buscó en el corpus base')
  })

  it('registro efímero perdido: los vectores que el registro no conoce no se sirven y un ID reutilizado no hereda restos', async () => {
    // Restos de un DOC-0001 anterior al reinicio, con más fragmentos que el nuevo.
    for (const indice of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const id = `kd_doc0001_v1_0_chunk_${indice}`
      pinecone.registros.set(id, { _id: id, content: `Licencia remunerada resto antiguo ${indice}`, article_id: 'kd_doc0001_v1_0', article_title: 'Antiguo', chunk_type: 'steps', visibleDesde: 0, __ns: NS_DOCS })
    }
    pinecone.registros.set('kd_doc0042_v1_0_chunk_1', { _id: 'kd_doc0042_v1_0_chunk_1', content: 'Licencia remunerada huérfana', article_id: 'kd_doc0042_v1_0', article_title: 'Huérfano', chunk_type: 'steps', visibleDesde: 0, __ns: NS_DOCS })

    // Un vector huérfano (DOC-0042) no rompe la consulta ni aparece como fuente.
    llm.subconsultas = []
    const sinDocumentos = await app.inject({ method: 'POST', url: '/api/consulta', payload: { question: '¿Cómo funciona la licencia remunerada?' } })
    assert.equal(sinDocumentos.statusCode, 200)
    assert.ok(!sinDocumentos.body.includes('kd_doc0042'), 'el huérfano no se usa')

    // El nuevo DOC-0001 reemplaza por completo los restos con su mismo prefijo.
    const carga = await subir('guia-licencias.txt', Buffer.from(TEXTO_CONOCIDO, 'utf8'))
    assert.equal(carga.json().documento.id, 'DOC-0001')
    const detalle = (await app.inject({ method: 'GET', url: '/api/documentos/DOC-0001' })).json()
    assert.equal(detalle.documento.estado, 'indexado')
    const propios = registrosKd().filter(registro => String(registro._id).startsWith('kd_doc0001_v1_0_chunk_'))
    assert.equal(propios.length, detalle.fragmentos.length)
    assert.ok(propios.every(registro => !String(registro.content).includes('resto antiguo')))
    const operacion = (await app.inject({ method: 'GET', url: `/api/operaciones/${detalle.operaciones[0].id}` })).json().operacion
    assert.match(operacion.pasos.find((paso: { nombre: string }) => paso.nombre === 'preparacion').detalle, /^9 registros previos/)
  })

  it('reemplazar y eliminar un documento de texto solo toca sus IDs en el namespace de documentos', async () => {
    const carga = await subir('politica-viaticos-v1.txt', await readFile(path.join(DEMO, 'politica-viaticos-v1.txt')))
    const docId: string = carga.json().documento.id
    const reemplazo = await app.inject({ method: 'POST', url: `/api/documentos/${docId}/reemplazo`, ...multipart('politica-viaticos-v2.docx', await readFile(path.join(DEMO, 'politica-viaticos-v2.docx'))) })
    assert.equal(reemplazo.statusCode, 202)
    await servicios.gestor.esperarInactividad()
    const detalle = (await app.inject({ method: 'GET', url: `/api/documentos/${docId}` })).json()
    assert.equal(detalle.version.version, '1.1')
    assert.equal(detalle.version.tipo, 'docx')
    assert.equal(detalle.version.articulo.id, 'politica_viaticos_v1_txt', 'conserva la identidad del documento')
    assert.ok(registrosKd().every(registro => String(registro._id).includes('_v1_1_chunk_')), 'la versión anterior se retiró del índice')

    const eliminacion = (await app.inject({ method: 'POST', url: `/api/documentos/${docId}/eliminacion`, payload: { confirmado: true } })).json()
    assert.equal(eliminacion.operacion.resultado, 'exitoso')
    assert.equal(registrosKd().length, 0)
    const borrados = pinecone.peticiones.filter(item => item.ruta === '/vectors/delete')
    assert.ok(borrados.length > 0)
    assert.ok(borrados.every(item => item.namespace === NS_DOCS && (item.ids ?? []).every(id => id.startsWith('kd_'))))
    assert.equal(pinecone.registros.get('base_articulo_chunk_1')?.__ns, NS_BASE, 'el corpus base sigue intacto')
  })
})

describe('HU07 · adaptador de escritura acotado al namespace de documentos', () => {
  const peticiones: string[] = []
  const fetchApi = async (input: string | URL | Request) => { peticiones.push(String(input)); return Response.json({}) }

  it('se niega a crearse sobre un namespace protegido', () => {
    assert.throws(() => crearIndicePinecone({ apiKey: 'k', indexHost: 'http://pinecone.simulado', namespace: NS_BASE }, {
      fetchApi, escrituraAcotada: { prefijo: 'kd_', namespacesProtegidos: [NS_BASE] },
    }), /namespace protegido/)
  })

  it('solo escribe, lista o borra IDs de Knowledge Desk', async () => {
    peticiones.length = 0
    const indice = crearIndicePinecone({ apiKey: 'k', indexHost: 'http://pinecone.simulado', namespace: NS_DOCS }, {
      fetchApi, maxRetries: 0, escrituraAcotada: { prefijo: 'kd_', namespacesProtegidos: [NS_BASE] },
    })
    for (const operacion of [
      () => indice.upsert([{ id: 'hardship_guide_chunk_1', texto: 'x', metadata: {} }]),
      () => indice.upsert([{ id: 'kd_doc0001_v1_0_chunk_1', texto: 'x', metadata: {} }, { id: 'ajeno', texto: 'y', metadata: {} }]),
      () => indice.listarIds('hardship_'),
      () => indice.eliminar(['hardship_guide_chunk_1']),
    ]) {
      await assert.rejects(operacion(), (error: unknown) => error instanceof IndiceError && error.tipo === 'solo_lectura')
    }
    assert.deepEqual(peticiones, [])
  })
})

describe('HU07 · clasificación kd-clasificacion-v1 con texto conocido', () => {
  it('cada regla clasifica su caso y respeta el orden de precedencia', () => {
    const casos: [Parameters<typeof clasificarBloque>[0], string, string][] = [
      [{ clase: 'pregunta', texto: '¿Cuál es el plazo máximo?' }, 'Preguntas', 'faqs'],
      [{ clase: 'item', texto: '1. Envía el formulario.' }, 'Cualquier sección', 'steps'],
      [{ clase: 'item', texto: '- Envía el formulario.' }, 'Procedimiento', 'steps'],
      [{ clase: 'parrafo', texto: 'Paso 2 revisa el soporte antes de enviarlo.' }, 'Detalle', 'steps'],
      [{ clase: 'parrafo', texto: 'Se entiende por comisión el viaje aprobado.' }, 'Texto', 'definitions'],
      [{ clase: 'parrafo', texto: 'Comisión: viaje aprobado por el jefe.' }, 'Glosario', 'definitions'],
      [{ clase: 'parrafo', texto: 'Pueden solicitar el auxilio quienes tengan contrato.' }, 'Texto', 'eligibility'],
      [{ clase: 'parrafo', texto: 'El valor del auxilio es de 120000 COP.' }, 'Texto', 'fees_details'],
      // Precedencia: una definición con importe y cifra sigue siendo definición.
      [{ clase: 'parrafo', texto: 'El auxilio se define como el pago diario de 120000 COP.' }, 'Texto', 'definitions'],
      [{ clase: 'parrafo', texto: 'El costo del servicio lo asume la empresa.' }, 'Texto', 'overview'],
      [{ clase: 'parrafo', texto: 'La solicitud debe enviarse con 5 días de plazo.' }, 'Texto', 'business_rules'],
      [{ clase: 'parrafo', texto: 'Esta guía resume el proceso para el personal.' }, 'Alcance', 'overview'],
    ]
    for (const [bloque, seccion, esperado] of casos) assert.equal(clasificarBloque(bloque, seccion), esperado, bloque.texto)
  })

  it('segmenta títulos, párrafos partidos por renglón, ítems y preguntas', () => {
    const bloques = segmentar('Título del documento\nAlcance\nEsta línea sigue\nen la siguiente.\n1. Primer paso.\n¿Una pregunta?\nRespuesta.')
    assert.deepEqual(bloques.map(bloque => [bloque.clase, bloque.texto]), [
      ['titulo', 'Título del documento'],
      ['titulo', 'Alcance'],
      ['parrafo', 'Esta línea sigue en la siguiente.'],
      ['item', '1. Primer paso.'],
      ['pregunta', '¿Una pregunta?'],
      ['parrafo', 'Respuesta.'],
    ])
  })

  it('un TXT de una sola línea sin punto final produce un fragmento con su texto', async () => {
    const texto = await extraerTexto('retiro.txt', 'txt', Buffer.from('El empleado debe solicitar el retiro', 'utf8'))
    const { fragmentos } = fragmentarTexto(texto, 'retiro.txt')
    assert.equal(fragmentos.length, 1)
    assert.match(fragmentos[0].texto, /El empleado debe solicitar el retiro$/)
    assert.equal(fragmentos[0].tipo, 'business_rules')
    // También con salto final, y con título y una única línea de cuerpo.
    assert.equal(fragmentarTexto('Plazo de retiro\n', 'x.txt').fragmentos.length, 1)
    assert.equal(fragmentarTexto('Retiros\nEl empleado debe solicitar el retiro', 'x.txt').fragmentos.length, 1)
  })

  it('el mismo contenido en PDF, DOCX y TXT produce los mismos tipos', async () => {
    const tipos = []
    for (const formato of ['pdf', 'docx', 'txt'] as const) {
      const texto = await extraerTexto(`x.${formato}`, formato, await readFile(path.join(DEMO, `politica-viaticos-v1.${formato}`)))
      tipos.push([...new Set(fragmentarTexto(texto, 'x').fragmentos.map(item => item.tipo))].sort())
    }
    assert.deepEqual(tipos[0], tipos[1])
    assert.deepEqual(tipos[1], tipos[2])
    assert.deepEqual(tipos[2], ['business_rules', 'fees_details', 'overview'])
  })
})
