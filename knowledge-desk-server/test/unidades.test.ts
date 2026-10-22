import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { ConfigError, loadConfig } from '../src/config.ts'
import { resumirRutas } from '../src/consulta/service.ts'
import { descomponer } from '../src/consulta/decompose.ts'
import { Registro } from '../src/documents/store.ts'
import { revisarEjemplo } from '../src/examples.ts'
import { crearIndicePinecone } from '../src/index/pinecone.ts'
import { IndiceError } from '../src/index/types.ts'
import { ProveedorError, crearProveedor, validarLote } from '../src/providers/openaiCompatible.ts'

describe('Embeddings: un lote corrupto nunca llega al índice', () => {
  it('rechaza índices repetidos, valores no numéricos y dimensiones distintas', () => {
    assert.throws(() => validarLote([{ index: 0, embedding: ['invalido'] }, { index: 0, embedding: [3, 4] }], 2, null), ProveedorError)
    assert.throws(() => validarLote([{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [3] }], 2, null), /dimensiones distintas/)
    assert.throws(() => validarLote([{ index: 0, embedding: [1, Number.NaN] }], 1, null), /no numéricos/)
    assert.throws(() => validarLote([{ index: 2, embedding: [1, 2] }], 1, null), /fuera de rango/)
    assert.throws(() => validarLote([{ index: 0, embedding: [1, 2] }], 2, null), /un embedding por texto/)
    // Un segundo lote debe mantener la dimensión del primero.
    assert.throws(() => validarLote([{ index: 0, embedding: [1, 2, 3] }], 1, 2), /dimensiones distintas/)
  })

  it('acepta un lote válido aunque llegue desordenado', () => {
    assert.deepEqual(validarLote([{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }], 2, null), [[1, 2], [3, 4]])
  })
})

describe('Proveedor OpenAI-compatible: reasoning_effort opcional (KD_CHAT_REASONING_EFFORT)', () => {
  async function cuerpoDelChat(variables: Record<string, string>) {
    const config = loadConfig({ KD_MODO: 'local', KD_LLM_BASE_URL: 'http://proveedor.simulado/v1', KD_EMBEDDINGS_MODEL: 'emb', KD_CHAT_MODEL: 'chat', KD_DATA_DIR: path.join(os.tmpdir(), 'kd-sin-uso'), ...variables })
    let enviado: Record<string, unknown> = {}
    const proveedor = crearProveedor(config.proveedor!, (async (_url: string | URL | Request, init?: RequestInit) => {
      enviado = JSON.parse(String(init?.body))
      return Response.json({ choices: [{ message: { content: '{"respuesta":"ok"}' } }] })
    }) as typeof fetch)
    await proveedor.chatJson([{ role: 'user', content: 'hola' }], new AbortController().signal)
    return enviado
  }

  it('sin la variable el cuerpo no cambia; con "none" se envía junto a temperature 0', async () => {
    const normal = await cuerpoDelChat({})
    assert.equal('reasoning_effort' in normal, false)
    assert.equal(normal.temperature, 0)
    const conEsfuerzo = await cuerpoDelChat({ KD_CHAT_REASONING_EFFORT: 'none' })
    assert.equal(conEsfuerzo.reasoning_effort, 'none')
    assert.equal(conEsfuerzo.temperature, 0)
  })

  it('cualquier otro valor se rechaza al cargar la configuración', () => {
    for (const valor of ['low', 'medium', 'NONE']) {
      assert.throws(() => loadConfig({ KD_MODO: 'local', KD_CHAT_REASONING_EFFORT: valor }), ConfigError, valor)
    }
  })
})

describe('Pinecone: cancelación real y filtro antes del topK', () => {
  const config = { apiKey: 'sintetica', indexHost: 'http://127.0.0.1:9', namespace: 'ns' }

  it('con la señal ya abortada no se envía ninguna petición', async () => {
    let peticiones = 0
    const indice = crearIndicePinecone(config, { fetchApi: async () => { peticiones++; return Response.json({}) }, maxRetries: 0 })
    const controlador = new AbortController()
    controlador.abort()
    await assert.rejects(indice.buscar('hola', 3, { signal: controlador.signal }), (error: unknown) => error instanceof IndiceError && error.tipo === 'cancelado')
    await assert.rejects(indice.listarIds('kd_', controlador.signal), IndiceError)
    assert.equal(peticiones, 0)
  })

  it('una búsqueda en vuelo recibe la señal y se corta', async () => {
    let senalRecibida: AbortSignal | null | undefined
    const indice = crearIndicePinecone(config, {
      maxRetries: 0,
      fetchApi: (_url, init) => new Promise((_, reject) => {
        senalRecibida = init?.signal
        init?.signal?.addEventListener('abort', () => reject(new DOMException('abortado', 'AbortError')))
      }),
    })
    const controlador = new AbortController()
    const promesa = indice.buscar('hola', 3, { signal: controlador.signal })
    setTimeout(() => controlador.abort(), 20)
    await assert.rejects(promesa, (error: unknown) => error instanceof IndiceError && error.tipo === 'cancelado')
    assert.equal(senalRecibida?.aborted, true)
  })

  it('las versiones excluidas viajan como filtro $nin dentro de la consulta', async () => {
    let cuerpo: Record<string, unknown> = {}
    const indice = crearIndicePinecone(config, {
      maxRetries: 0,
      fetchApi: async (_url, init) => {
        cuerpo = JSON.parse(String(init?.body))
        return Response.json({ result: { hits: [] }, usage: { readUnits: 1 } })
      },
    })
    await indice.buscar('hola', 5, { excluirArticulos: ['kd_doc0001_v1_0'] })
    assert.deepEqual(cuerpo.query, { top_k: 5, inputs: { text: 'hola' }, filter: { article_id: { $nin: ['kd_doc0001_v1_0'] } } })
  })
})

describe('Ubicación de una fuente', () => {
  it('resume las rutas JSON de los fragmentos usados', () => {
    assert.equal(resumirRutas(['details.steps[0]', 'details.steps[1]', 'details.steps[2]']), 'details.steps[0–2]')
    assert.equal(resumirRutas(['details.steps[3]']), 'details.steps[3]')
    assert.equal(resumirRutas(['details.guardrails']), 'details.guardrails')
    assert.equal(resumirRutas(['details.business_rules[0]', 'details.critical_flags', 'details.fees']), 'details.business_rules[0], details.critical_flags…')
    assert.equal(resumirRutas([]), null)
  })
})

describe('Descomposición de preguntas (HU02)', () => {
  it('separa temas distintos y deja intacta una pregunta de un solo tema', () => {
    assert.deepEqual(descomponer('¿Cuál es el plazo del reembolso y qué documentos debo adjuntar?'), ['¿Cuál es el plazo del reembolso?', '¿qué documentos debo adjuntar?'])
    assert.deepEqual(descomponer('¿Cómo hago un rollover de mi 401(k) a otro proveedor?'), [])
    assert.equal(descomponer('¿Qué es el plazo de pago? ¿Quién aprueba el viaje? ¿Dónde se registra el gasto?').length, 3)
  })
})

describe('Rutas y ejemplos', () => {
  it('ninguna ruta del registro sale del directorio de datos', async () => {
    const registro = new Registro('/tmp/kd-datos')
    assert.throws(() => registro.rutaArchivo('../fuera.json'), /fuera del directorio/)
    assert.throws(() => registro.rutaArchivo('archivos/../../fuera.json'), /fuera del directorio/)
    await assert.rejects(registro.guardarArchivo('../DOC', '1.0', 'a.json', Buffer.from('{}')), /no válido/)
  })

  it('un ejemplo que promete datos personales, financieros o de sistemas externos se rechaza', () => {
    assert.equal(revisarEjemplo('¿Cuál es mi saldo en la cuenta?'), 'promete datos personales o financieros')
    assert.equal(revisarEjemplo('¿Cuál es el número de mi cédula registrada?'), 'pide un dato de identidad')
    assert.equal(revisarEjemplo('¿Cómo creo un ticket en DevRev para esto?'), 'menciona un sistema externo')
    assert.equal(revisarEjemplo('¿Qué es una distribución mínima requerida (RMD)?'), null)
  })
})
