import { articulo, json, type Datos } from './articulos.ts'

// Corpus DEMO explícito: artículos de conocimiento kb_article_v2 FICTICIOS para
// probar el flujo completo con servicios simulados. No forma parte del modo
// normal, no contiene datos reales y no copia artículos de ForUsGuide.
export const PREGUNTA_VIATICOS = '¿Cuál es el procedimiento para reembolso de viáticos internacionales?'

const CONTACTO_TESORERIA = { email: 'tesoreria@empresa.invalid', phone: null, support_hours: 'Lunes a viernes, 8:00 a 17:00' }

export const VIATICOS_V1 = articulo('politica_viaticos_internacionales', 'Política de viáticos internacionales', {
  critical_flags: { portal_required: true, mfa_relevant: false, record_keeper_must_be: null },
  business_rules: [
    { category: 'eligibility', rules: ['Solo se reembolsan viáticos internacionales de viajes de trabajo aprobados antes de la salida.'] },
    { category: 'plazos', rules: ['El reembolso de viáticos internacionales se solicita en el portal de gastos dentro de los 15 días posteriores al viaje.', 'Los gastos sin factura o fuera de plazo no son reembolsables.'] },
  ],
  steps: [
    { step_number: 1, type: 'action', visibility: 'participant', description: 'Ingresa al portal de gastos y abre una solicitud de reembolso de viáticos internacionales.', notes: null },
    { step_number: 2, type: 'action', visibility: 'participant', description: 'Adjunta las facturas originales y el formato de legalización de gastos.', notes: 'Las facturas deben estar a nombre de la empresa.' },
    { step_number: 3, type: 'action', visibility: 'participant', description: 'Envía la solicitud para la aprobación del jefe inmediato antes del pago.', notes: '' },
  ],
  faq_pairs: [
    { question: '¿Cuándo se pagan los viáticos internacionales aprobados?', answer: 'Tesorería paga los viáticos internacionales aprobados en el siguiente ciclo de pagos.' },
  ],
  references: { participant_portal: 'Portal de gastos (intranet)', contact: CONTACTO_TESORERIA, internal_articles: [], external_links: [] },
}, {
  description: 'Cómo solicitar el reembolso de viáticos internacionales de un viaje de trabajo aprobado.',
  tags: ['viaticos', 'reembolso', 'viajes'],
  topic: 'viaticos',
  subtopics: ['reembolso', 'legalizacion'],
})

export const VIATICOS_V2 = articulo('politica_viaticos_internacionales', 'Política de viáticos internacionales', {
  critical_flags: { portal_required: true, mfa_relevant: false, record_keeper_must_be: null },
  business_rules: [
    { category: 'eligibility', rules: ['Solo se reembolsan viáticos internacionales de viajes de trabajo aprobados antes de la salida.'] },
    { category: 'plazos', rules: ['El reembolso de viáticos internacionales se solicita en el portal de gastos dentro de los 10 días hábiles posteriores al viaje.', 'Los viáticos internacionales aprobados se pagan en un máximo de cinco días hábiles.'] },
  ],
  steps: [
    { step_number: 1, type: 'action', visibility: 'participant', description: 'Ingresa al portal de gastos y abre una solicitud de reembolso de viáticos internacionales.', notes: null },
    { step_number: 2, type: 'action', visibility: 'participant', description: 'Adjunta las facturas electrónicas y el formato de legalización firmado.', notes: null },
    { step_number: 3, type: 'action', visibility: 'participant', description: 'Envía la solicitud: la aprueban el jefe inmediato y el área financiera.', notes: null },
  ],
  references: { participant_portal: 'Portal de gastos (intranet)', contact: CONTACTO_TESORERIA, internal_articles: [], external_links: [] },
}, {
  description: 'Cómo solicitar el reembolso de viáticos internacionales (versión actualizada).',
  tags: ['viaticos', 'reembolso', 'viajes'],
  topic: 'viaticos',
  subtopics: ['reembolso', 'legalizacion'],
  last_updated: '2026-04-15',
})

const PRIVACIDAD = articulo('politica_privacidad_2023', 'Política de privacidad 2023', {
  critical_flags: { portal_required: false, mfa_relevant: false, record_keeper_must_be: null },
  business_rules: [
    { category: 'tratamiento', rules: ['Los datos personales de colaboradores se tratan solo para fines laborales autorizados.', 'Toda solicitud de acceso a datos personales se registra y se responde en un plazo de 15 días.'] },
    { category: 'conservacion', rules: ['Los registros se conservan durante el tiempo exigido por la normativa aplicable y luego se eliminan de forma segura.'] },
  ],
  definitions: [
    { term: 'Dato personal', definition: 'Información que identifica o hace identificable a una persona colaboradora.' },
    { term: 'Titular', definition: 'Persona a quien se refieren los datos personales.' },
  ],
  guardrails: {
    must_not: ['No compartas datos personales de otra persona por chat ni correo.'],
    must_do_if_unsure: ['Remite la solicitud al área responsable de privacidad.'],
  },
  references: {
    participant_portal: null,
    contact: { email: 'privacidad@empresa.invalid', phone: null, support_hours: null },
    internal_articles: [],
    // Variante con objetos {label, url, purpose}.
    external_links: [{ label: 'Formulario de solicitud de acceso', url: 'https://intranet.empresa.invalid/privacidad', purpose: 'Registrar solicitudes de acceso a datos' }],
  },
}, { description: 'Reglas internas para el tratamiento de datos personales de colaboradores.', tags: ['privacidad', 'datos personales'], topic: 'privacidad' })

const OPERACIONES = articulo('manual_operaciones_v2', 'Manual de operaciones', {
  critical_flags: { portal_required: false, mfa_relevant: false, record_keeper_must_be: null },
  required_data: {
    must_have: [
      // Sin blocking_intent: el chunker de ForUsGuide lo trata como "always".
      { data_point: 'Número de incidente', meaning: 'Identificador del incidente en el tablero de turno.', why_needed: 'Permite escalar y documentar el caso.', source_type: 'portal', example_values: ['INC-1042'] },
    ],
    nice_to_have: [],
    if_missing: [
      { missing_data_point: 'Número de incidente', ask_participant: null, agent_note: 'Registrar el incidente en el tablero antes de escalarlo.' },
    ],
    disambiguation_notes: [],
  },
  decision_guide: {
    supported_outcomes: ['escalar', 'resolver_en_turno'],
    eligibility_requirements: [],
    blocking_conditions: ['El incidente no está registrado en el tablero.'],
    missing_data_conditions: [],
    allowed_conclusions: ['Un incidente crítico se escala al coordinador de turno.'],
    not_allowed_conclusions: ['No cierres un incidente crítico sin documentarlo en la bitácora.'],
  },
  steps: [
    { step_number: 1, type: 'action', visibility: 'internal', description: 'Al iniciar el turno, revisa el tablero de incidentes y asigna responsables.', notes: null },
    { step_number: 2, type: 'action', visibility: 'internal', description: 'Escala cada incidente crítico al coordinador de turno en menos de 30 minutos.', notes: 'Documenta el escalamiento en la bitácora.' },
  ],
  common_issues: [
    { issue: 'El tablero de incidentes no carga en el portal.', resolution: 'Usa la bitácora de respaldo y avisa a soporte técnico.' },
  ],
  // Variante de additional_notes como lista de textos.
  additional_notes: ['El coordinador de turno publica el resumen del turno al cierre.'],
}, { description: 'Operación diaria del turno y escalamiento de incidentes.', tags: ['operaciones', 'incidentes'], topic: 'operaciones' })

const ESTILO = articulo('guia_estilo_archivistica', 'Guía de estilo archivística', {
  steps: [
    { step_number: 1, type: 'action', visibility: 'internal', description: 'Rotula cada expediente con código de serie, fecha de apertura y responsable del archivo.', notes: null },
    { step_number: 2, type: 'action', visibility: 'internal', description: 'Ordena los documentos cronológicamente y fólialos antes de la transferencia al archivo central.', notes: null },
  ],
  examples: [
    { scenario: 'Un expediente llega sin código de serie.', outcome: 'Se devuelve al área de origen para rotularlo antes de recibirlo.' },
  ],
  additional_notes: [
    { category: 'transferencias', notes: ['La transferencia al archivo central se hace una vez al año con inventario firmado.'] },
  ],
}, { description: 'Rotulado, orden y transferencia de expedientes.', tags: ['archivo'], topic: 'gestion_documental' })

const FINANCIERO = articulo('reporte_financiero_q3', 'Procedimiento de reporte financiero trimestral', {
  business_rules: [
    { category: 'consolidacion', rules: ['El área financiera consolida el reporte trimestral con los cierres contables aprobados de cada unidad.'] },
  ],
  steps: [
    { step_number: 1, type: 'action', visibility: 'internal', description: 'Cada unidad envía su cierre contable aprobado al área financiera.', notes: null },
    { step_number: 2, type: 'action', visibility: 'internal', description: 'El comité financiero revisa el reporte antes de su publicación interna.', notes: null },
  ],
  fees: [],
}, { description: 'Consolidación y revisión del reporte financiero trimestral.', tags: ['finanzas'], topic: 'finanzas' })

// Borrador sin contenido indexable: solo secciones vacías y una clave ajena al
// esquema. Su carga termina en Error y nunca se publica.
const BORRADOR = articulo('borrador_procedimiento_compras', 'Borrador de procedimiento de compras', {
  critical_flags: { portal_required: false, mfa_relevant: false, record_keeper_must_be: null },
  business_rules: [],
  steps: [{ step_number: 1, type: 'action', visibility: 'internal', description: '', notes: null }],
  notas_de_redaccion: 'Pendiente de redactar el procedimiento completo con el área de compras.',
})

const GASTOS = articulo('manual_gastos_viaje', 'Manual de gastos de viaje', {
  business_rules: [
    { category: 'registro', rules: ['Los gastos de viaje nacionales e internacionales se registran en el portal de gastos con su factura.'] },
    { category: 'legalizacion', rules: ['La legalización de gastos se presenta con el formato oficial y la firma del responsable del viaje.'] },
  ],
}, { description: 'Registro y legalización de gastos de viaje.', tags: ['gastos'], topic: 'gastos' })

export const ARTICULOS_DEMO: Record<string, Datos> = {
  'Política_Privacidad_2023.json': PRIVACIDAD,
  'Manual_Operaciones_V2.json': OPERACIONES,
  'Guia_Estilo_Archivistica.json': ESTILO,
  'Reporte_Financiero_Q3.json': FINANCIERO,
  'Borrador_Incompleto.json': BORRADOR,
  'Politica_Viaticos_v3.2.json': VIATICOS_V1,
  'Politica_Viaticos_v3.3.json': VIATICOS_V2,
  'Manual_Gastos.json': GASTOS,
}

export function documentosDemo(): Record<string, Buffer> {
  return Object.fromEntries(Object.entries(ARTICULOS_DEMO).map(([nombre, datos]) => [nombre, json(datos)]))
}
