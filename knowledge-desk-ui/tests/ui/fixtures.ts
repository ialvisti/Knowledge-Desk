import type { BrowserContext, Page, Route } from '@playwright/test'

// FIXTURES DE PRUEBA. Sustituyen al servidor dentro del navegador para fijar
// estados exactos de la interfaz. No forman parte del modo normal: en uso real
// todos estos datos llegan del servidor de Knowledge Desk.

export const EJEMPLOS_PDF = [
  '¿Qué es un retiro por dificultad económica (hardship withdrawal) y quién califica?',
  '¿Cómo hago un rollover de mi 401(k) a otro proveedor?',
  '¿Qué es una distribución mínima requerida (RMD) y cuándo empieza?',
  '¿Qué es el force-out y desde qué saldo de cuenta aplica?',
]

export const PREGUNTA_ROLLOVER = '¿Cómo hago un rollover de mi 401(k) a otro proveedor?'
export const PREGUNTA_VIATICOS = '¿Cuál es el procedimiento para reembolso de viáticos internacionales?'

export const estado = {
  modo: 'forusguide',
  consulta: { configurada: true, motor: 'forusguide' },
  indexacion: { configurada: true, destino: 'Pinecone · namespace kb_articles' },
  faltan: [],
  limites: { preguntaMin: 10, preguntaMax: 2000, archivoMaxBytes: 52428800, formatos: ['json'], esquema: 'kb_article_v2' },
  simulado: false,
  datosTemporales: false,
  consultaTimeoutMs: 90000,
  cobertura: { politica: 'kd-cobertura-v1', umbralRelevancia: 0.2 },
  usuario: 'operador.tecnico',
  puedeAdministrar: true,
  accesoControlado: false,
  accesoPublico: false,
  contactoUrl: 'mailto:area.responsable@empresa.invalid',
  revisionCorpus: 1,
  residuosPendientes: 0,
}

function fuente(id: string, title: string, affinity: number, fragmentos: number) {
  return {
    id, kind: 'external_article', title, file_name: null, article_id: id, href: `/fuentes/${id}`, document_id: null, version: null, location: null, affinity, fragment_count: fragmentos,
    fragments: Array.from({ length: fragmentos }, (_, i) => ({ id: `${id}_chunk_${i + 1}`, affinity: Number((affinity - i * 0.01).toFixed(2)), type: 'steps', paths: [], operational: false, content: `Fragmento ${i + 1} de ${title}.` })),
  }
}

export const RESPUESTA_ROLLOVER = 'Para hacer un rollover de tu 401(k) a otro proveedor, la idea general es mover tus fondos a una IRA u otro plan de jubilación calificado sin impuestos o penalidades inmediatas, siempre que se haga correctamente.\n\nPasos generales según el proceso de ForUsAll/LT Trust:\n\n1. Confirma con el proveedor receptor sus instrucciones\n\nAntes de enviar la solicitud, confirma con la institución que recibirá el dinero cómo prefiere recibir rollovers: por cheque o por wire transfer. ACH no es un método disponible para un rollover directo.\n\n1. Inicia la solicitud de distribución/rollover\n\nEn el proceso de distribución, debes elegir el tipo de distribución. Las opciones incluyen, entre otras:\n\n- Rollover directo de tu saldo vested a una IRA o a un plan de jubilación calificado.\n- Rollover directo parcial a una IRA o plan calificado, con el resto como distribución en efectivo.\n\n1. Proporciona la información de entrega\n\nPara un rollover por cheque, debes proporcionar datos como:\n\n- Institución receptora.\n- Dirección postal.\n- Tipo de destino del rollover: IRA, Qualified Plan, Roth IRA o Roth Qualified Plan.\n- Número de IRA o subcuenta, si aplica.'

export const contratoRespuesta = {
  status: 'ok',
  request_id: 'req-7f3a9c2e',
  question: PREGUNTA_ROLLOVER,
  outcome: 'answered',
  answer: RESPUESTA_ROLLOVER,
  key_points: [
    'Un rollover directo a una IRA u otro plan calificado puede evitar impuestos y penalidades inmediatas si se hace correctamente.',
    'Para rollovers directos, los métodos disponibles son cheque o wire; ACH no es un método de entrega para rollover directo.',
    'Debes confirmar con el proveedor receptor sus instrucciones exactas antes de enviar la solicitud.',
    'Los fondos Roth y pre-tax se separan automáticamente y deben enviarse al tipo de cuenta correspondiente; los fondos Roth deben ir a una cuenta Roth.',
    'Si los fondos se pagan primero al participante, generalmente deben depositarse en una cuenta elegible dentro de 60 días para evitar impuestos y posibles penalidades.',
  ],
  coverage: {
    level: 'alta', label: 'Cobertura alta', explanation: 'Varias fuentes aprobadas tratan directamente tu consulta.', sufficient: true,
    relevant_fragments: 18, total_fragments: 18, documents: 4, policy: 'kd-cobertura-v1', basis: 'motor',
  },
  sources: [
    fuente('terminated_distribution_options', '401(k) Options After Leaving Your Job (Terminated Distribution): Rollovers, Cash Outs, Roth and Pre-Tax', 0.62, 5),
    fuente('missed_60_day_rollover', 'Missed 60-Day Indirect Rollover Deadline: Tax Consequences, IRS Exceptions, and When to Refer to a Tax Professional', 0.58, 6),
    fuente('lt_split_rollover', 'LT: Can I Split My 401(k) Rollover Between Multiple Providers?', 0.56, 3),
    fuente('lt_termination_withdrawal', 'LT: How to Request a 401(k) Termination Cash Withdrawal or Rollover', 0.55, 4),
  ],
  found_documents: [],
  contradictions: [],
  retrieval: { fragments_retrieved: 18, articles_consulted: 4, model: 'gpt-5.5', sub_queries: ['direct rollover 401k to another provider check wire instructions', PREGUNTA_ROLLOVER], generated: true },
  engine: 'forusguide',
  elapsed_ms: 14_200,
  corpus_revision: 1,
}

export const contratoInsuficiente = {
  ...contratoRespuesta,
  request_id: 'req-3d1e0b9a',
  question: PREGUNTA_VIATICOS,
  outcome: 'insufficient',
  answer: null,
  key_points: [],
  coverage: {
    level: 'baja', label: 'Cobertura baja', explanation: 'La documentación disponible apenas toca tu consulta. No es suficiente para responder con confianza.', sufficient: false,
    relevant_fragments: 1, total_fragments: 5, documents: 1, policy: 'kd-cobertura-v1', basis: 'motor',
  },
  sources: [],
  found_documents: [{
    id: 'kd_doc0042_v3_2', kind: 'document', title: 'Política de viáticos internacionales', file_name: 'Politica_Viaticos_v3.2.json', article_id: 'politica_viaticos_internacionales',
    href: '/documentos/DOC-0042?version=3.2', document_id: 'DOC-0042', version: '3.2', location: 'details.business_rules[1]', affinity: 0.24, fragment_count: 1,
    fragments: [{ id: 'kd_doc0042_v3_2_chunk_8', affinity: 0.24, type: 'business_rules', paths: ['details.business_rules[1]'], operational: false, content: 'Los viáticos nacionales se liquidan con el formato de legalización.' }],
  }],
}

export const contratoSinEvidencia = {
  ...contratoInsuficiente,
  request_id: 'req-5b77c210',
  coverage: { ...contratoInsuficiente.coverage, level: 'sin_evidencia', label: 'Sin evidencia', explanation: 'No se encontró ningún fragmento relevante en las fuentes aprobadas.', relevant_fragments: 0, total_fragments: 0, documents: 0 },
  found_documents: [],
}

export function errorContrato(code: string, message: string, request_id: string, status: number, details: Record<string, unknown> = {}) {
  return { status, body: { status: 'error', code, message, details: { retryable: true, ...details }, request_id } }
}

export const ERRORES = {
  validacion: errorContrato('VALIDATION_ERROR', 'La pregunta no es válida: necesita al menos 10 caracteres.', 'req-1b44d0a7', 422, { retryable: false, motivo: 'corta' }),
  recuperacion: errorContrato('RETRIEVAL_ERROR', 'Ocurrió un problema al recuperar la información. Inténtalo de nuevo en unos minutos.', 'req-c92e51f8', 502),
  baseVectorial: errorContrato('VECTOR_DB_UNAVAILABLE', 'El servicio de búsqueda no responde en este momento. Inténtalo de nuevo más tarde.', 'req-a03d77b2', 503),
  proveedor: errorContrato('AI_PROVIDER_ERROR', 'El servicio que redacta las respuestas falló. Inténtalo de nuevo en unos minutos.', 'req-e58b19c4', 502),
  tiempo: errorContrato('TIMEOUT', 'La consulta superó el tiempo máximo de espera. Inténtalo de nuevo o simplifica la pregunta.', 'req-9d2f41aa', 504),
  noDisponible: errorContrato('CONTENT_UNAVAILABLE', 'La respuesta se apoyaba en un documento que está en proceso, bloqueado o retirado, así que no se presenta. Inténtalo de nuevo cuando termine la operación.', 'req-41c0de77', 409),
}

export interface Respuesta { status: number; body: unknown; retrasoMs?: number }

export interface Simulacion {
  consulta?: (cuerpo: { question: string }, intento: number) => Respuesta | null
  estado?: Partial<typeof estado>
  estadoRetrasoMs?: number
  ejemplos?: string[]
  documentos?: unknown[]
  // false: el servidor no tiene indexación configurada (por defecto true).
  indexacion?: boolean
  // Revisión del corpus del servidor simulado (estado y documentos la informan igual).
  revision?: number
  // Rutas adicionales (detalle de un documento, archivo original, fuentes).
  otras?: Record<string, { status?: number; body: unknown; contentType?: string; headers?: Record<string, string> }>
}

export interface Registro {
  consultas: { question: string; requestId: string | null }[]
  estados: number
  // Cambiar la revisión simula una carga, reemplazo o eliminación de otro operador.
  revision: number
  // Con true, /api/estado no responde (red caída o servidor no disponible).
  estadoFalla: boolean
}

// Sustituye /api/* dentro del navegador (una página o todo el contexto, para
// varias pestañas). Devuelve el registro de solicitudes para comprobar, por
// ejemplo, que una pregunta vacía no se envía.
export async function simularServidor(destino: Page | BrowserContext, simulacion: Simulacion = {}): Promise<Registro> {
  const registro: Registro = { consultas: [], estados: 0, revision: simulacion.revision ?? simulacion.estado?.revisionCorpus ?? 1, estadoFalla: false }
  // Solo la API del servidor (/api/...): los módulos de la interfaz en
  // /src/api/*.ts no deben interceptarse.
  await destino.route(url => url.pathname.startsWith('/api/'), async (route: Route) => {
    const url = new URL(route.request().url())
    const responder = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const otra = simulacion.otras?.[`${url.pathname}${url.search}`] ?? simulacion.otras?.[url.pathname]
    if (otra) {
      return route.fulfill({ status: otra.status ?? 200, contentType: otra.contentType ?? 'application/json', headers: otra.headers, body: typeof otra.body === 'string' ? otra.body : JSON.stringify(otra.body) })
    }
    if (url.pathname === '/api/estado') {
      registro.estados++
      if (registro.estadoFalla) return route.abort('connectionrefused')
      if (simulacion.estadoRetrasoMs) await new Promise(resolve => setTimeout(resolve, simulacion.estadoRetrasoMs))
      return responder(200, { ...estado, ...simulacion.estado, revisionCorpus: registro.revision })
    }
    if (url.pathname === '/api/ejemplos') return responder(200, { examples: simulacion.ejemplos ?? EJEMPLOS_PDF, verified: true, note: null, rejected: [] })
    if (url.pathname === '/api/documentos') return responder(200, { documentos: simulacion.documentos ?? [], indexacionConfigurada: simulacion.indexacion ?? true, revisionCorpus: registro.revision })
    if (url.pathname === '/api/consulta') {
      const cuerpo = JSON.parse(route.request().postData() ?? '{}') as { question: string }
      registro.consultas.push({ question: cuerpo.question, requestId: route.request().headers()['x-request-id'] ?? null })
      const respuesta = simulacion.consulta?.(cuerpo, registro.consultas.length) ?? { status: 200, body: { ...contratoRespuesta, question: cuerpo.question, corpus_revision: registro.revision } }
      if (respuesta.retrasoMs) await new Promise(resolve => setTimeout(resolve, respuesta.retrasoMs))
      return responder(respuesta.status, respuesta.body)
    }
    return responder(404, { status: 'error', code: 'NOT_FOUND', message: 'No existe en la simulación', details: null, request_id: 'req-00000000' })
  })
  return registro
}
