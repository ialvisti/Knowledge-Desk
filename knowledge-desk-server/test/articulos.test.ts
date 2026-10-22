import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { Worker } from 'node:worker_threads'
import { KdError } from '../src/errors.ts'
import { LONGITUD_MAXIMA, validarArchivoArticulo, validarArticulo } from '../src/documents/articulo.ts'
import { MAXIMO_FRAGMENTO, contenidoUtil, fragmentarArticulo, partir, type Fragmento } from '../src/documents/chunker.ts'
import { articulo, json, type Datos } from './support/articulos.ts'

const MB = 1024 * 1024
const aArticulo = (datos: Datos) => validarArticulo(datos).articulo
const tipos = (fragmentos: Fragmento[]) => fragmentos.map(fragmento => fragmento.tipo)

function errorKd(codigo: string, mensaje?: RegExp) {
  return (error: unknown) => error instanceof KdError && error.code === codigo && (!mensaje || mensaje.test(error.message))
}

// Ejecuta el chunker en otro hilo con un límite de tiempo: un bucle sin fin
// hace fallar la prueba en lugar de bloquear el proceso de pruebas.
async function fragmentarConLimite(datos: Datos, ms = 5000): Promise<Fragmento[]> {
  const hilo = new Worker(new URL('./support/fragmentar-en-hilo.ts', import.meta.url), { workerData: aArticulo(datos) })
  try {
    return await new Promise<Fragmento[]>((resolve, reject) => {
      const reloj = setTimeout(() => reject(new Error(`fragmentarArticulo no terminó en ${ms} ms`)), ms)
      hilo.once('message', fragmentos => { clearTimeout(reloj); resolve(fragmentos as Fragmento[]) })
      hilo.once('error', error => { clearTimeout(reloj); reject(error) })
    })
  } finally {
    await hilo.terminate()
  }
}

// Texto de un fragmento sin el encabezado que se repite en las partes 2..n.
function cuerpoDeParte(fragmento: Fragmento) {
  return fragmento.parte && fragmento.parte[0] > 1 ? fragmento.texto.slice(fragmento.texto.indexOf('\n') + 1) : fragmento.texto
}
const normalizar = (texto: string) => texto.replace(/\s+/g, ' ').trim()

describe('Validación kb_article_v2', () => {
  it('acepta el mínimo que exige el procesador de ForUsGuide y los nulos globales', () => {
    const { articulo: valido, resumen } = validarArticulo({
      metadata: { article_id: 'minimo_v2', title: 'Artículo mínimo', record_keeper: null, plan_type: null },
      details: { steps: [{ step_number: 1, description: 'Un paso con suficiente texto para sustentar una respuesta.' }] },
    })
    assert.equal(resumen.id, 'minimo_v2')
    assert.equal(resumen.recordKeeper, null)
    assert.equal(resumen.planType, null)
    assert.deepEqual(resumen.avisos, [])
    assert.equal(contenidoUtil(valido), true)
  })

  it('exige metadata.article_id, title, record_keeper y plan_type (estos dos pueden ser null)', () => {
    const base = { article_id: 'a', title: 'T', record_keeper: null, plan_type: null }
    for (const [clave, valor] of [['article_id', undefined], ['title', '  '], ['record_keeper', undefined], ['plan_type', undefined]] as const) {
      const metadata: Datos = { ...base }
      if (valor === undefined) delete metadata[clave]
      else metadata[clave] = valor
      assert.throws(() => validarArticulo({ metadata, details: {} }), errorKd('INVALID_ARTICLE', new RegExp(`metadata\\.${clave}`)))
    }
    assert.throws(() => validarArticulo({ metadata: base }), errorKd('INVALID_ARTICLE', /\$\.details/))
    assert.throws(() => validarArticulo([]), errorKd('INVALID_ARTICLE', /raíz/))
  })

  it('un tipo anidado inválido se informa con su ruta JSON exacta', () => {
    const datos = articulo('anidado', 'Anidado', { steps: [{ description: 'Uno' }, { description: 'Dos' }, { description: 5 }] })
    assert.throws(() => validarArticulo(datos), (error: unknown) => error instanceof KdError && error.code === 'INVALID_ARTICLE' && (error.details as { ruta: string }).ruta === 'details.steps[2].description')
    assert.throws(() => validarArticulo(articulo('x', 'X', { business_rules: [{ category: 'a', rules: 'no es lista' }] })), errorKd('INVALID_ARTICLE', /details\.business_rules\[0\]\.rules/))
    assert.throws(() => validarArticulo(articulo('x', 'X', { response_frames: { aprobado: [] } })), errorKd('INVALID_ARTICLE', /details\.response_frames\.aprobado/))
  })

  it('"summary" y claves raíz ajenas se conservan en el original con aviso, sin rechazar el artículo', () => {
    const { resumen } = validarArticulo({ ...articulo('con_summary', 'Con summary', {}), summary: { overview: 'legado' }, extra: 1 })
    assert.equal(resumen.avisos.length, 2)
    assert.match(resumen.avisos[0], /summary/)
    assert.match(resumen.avisos[1], /"extra"/)
  })

  it('limita la longitud de los identificadores del artículo', () => {
    assert.doesNotThrow(() => validarArticulo(articulo('a'.repeat(LONGITUD_MAXIMA.article_id), 'T'.repeat(LONGITUD_MAXIMA.title), {})))
    assert.throws(() => validarArticulo(articulo('a'.repeat(LONGITUD_MAXIMA.article_id + 1), 'T', {})), errorKd('INVALID_ARTICLE', /metadata\.article_id: supera/))
    assert.throws(() => validarArticulo(articulo('a', 'T'.repeat(LONGITUD_MAXIMA.title + 1), {})), errorKd('INVALID_ARTICLE', /metadata\.title: supera/))
  })

  it('el archivo: solo .json, no vacío, dentro del límite, UTF-8 y JSON bien formado', () => {
    const valido = json(articulo('archivo', 'Archivo', {}))
    assert.throws(() => validarArchivoArticulo('articulo.pdf', valido, MB), errorKd('UNSUPPORTED_FORMAT', /JSON/))
    assert.throws(() => validarArchivoArticulo('articulo.txt', valido, MB), errorKd('UNSUPPORTED_FORMAT'))
    assert.throws(() => validarArchivoArticulo('vacio.json', Buffer.alloc(0), MB), errorKd('EMPTY_FILE'))
    assert.throws(() => validarArchivoArticulo('blancos.json', Buffer.from(' \n '), MB), errorKd('EMPTY_FILE'))
    assert.throws(() => validarArchivoArticulo('grande.json', valido, 10), errorKd('FILE_TOO_LARGE'))
    assert.throws(() => validarArchivoArticulo('malformado.json', Buffer.from('{"metadata": {'), MB), errorKd('INVALID_ARTICLE', /no es JSON válido/))
    assert.throws(() => validarArchivoArticulo('latin1.json', Buffer.from('{"a":"\xe1"}', 'latin1'), MB), errorKd('INVALID_ARTICLE', /UTF-8/))
    // Con BOM y mayúsculas en la extensión también es un artículo válido.
    assert.equal(validarArchivoArticulo('CON_BOM.JSON', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valido]), MB).resumen.id, 'archivo')
  })
})

describe('Fragmentación (port del KBChunker de ForUsGuide)', () => {
  const completo = articulo('completo', 'Artículo completo', {
    required_data: {
      must_have: [{ data_point: 'Saldo de la cuenta', meaning: 'Saldo disponible.', why_needed: 'Define si aplica.', source_type: 'portal', example_values: ['$1,000'] }],
      nice_to_have: [{ data_point: 'Motivo', meaning: 'Motivo de la solicitud.', why_needed: 'Contexto.', example_values: [] }],
      if_missing: [{ missing_data_point: 'Saldo de la cuenta', ask_participant: null, agent_note: 'Consultarlo en el portal.' }],
      disambiguation_notes: ['Saldo disponible no es saldo total.'],
    },
    critical_flags: { portal_required: true, mfa_relevant: false, record_keeper_must_be: null },
    business_rules: [
      { category: 'eligibility', rules: ['Aplica a cuentas activas.'] },
      { category: 'fees', rules: ['El trámite cuesta 25 unidades.'] },
      { category: 'plazos', rules: ['Se responde en 5 días.'] },
    ],
    decision_guide: { supported_outcomes: ['aprobar'], eligibility_requirements: [], blocking_conditions: ['Cuenta inactiva.'], missing_data_conditions: [{ condition: 'Sin saldo', missing_data_point: 'Saldo', resulting_outcome: 'pedir dato', ask_participant: '¿Cuál es tu saldo?' }], allowed_conclusions: [], not_allowed_conclusions: [] },
    response_frames: { aprobar: { participant_message_components: ['Confirma la aprobación.'], next_steps: [], warnings: [], questions_to_ask: [], what_not_to_say: [] } },
    guardrails: { must_not: ['No prometas plazos.'], must_do_if_unsure: [] },
    steps: Array.from({ length: 7 }, (_, indice) => ({ step_number: indice + 1, description: `Paso número ${indice + 1} del procedimiento.`, notes: null })),
    common_issues: [{ issue: 'No puedo entrar al portal', resolution: 'Restablece la contraseña.' }, { issue: 'El check de pago no llegó', resolution: 'Espera diez días.' }, { issue: 'Error de sistema', resolution: 'Reintenta.' }],
    examples: [{ scenario: 'Cuenta activa con saldo.', outcome: 'Se aprueba.' }],
    faq_pairs: Array.from({ length: 4 }, (_, indice) => ({ question: `¿Pregunta ${indice + 1}?`, answer: `Respuesta ${indice + 1}.` })),
    definitions: [{ term: 'Saldo', definition: 'Dinero disponible.' }],
    additional_notes: [{ category: 'otros', notes: ['Nota adicional.'] }],
    references: { participant_portal: 'Portal', contact: { email: 'a@b.invalid', phone: null, support_hours: null }, internal_articles: [], external_links: ['Guía en texto', { label: 'Formulario', url: 'https://ejemplo.invalid/f', purpose: 'Solicitar' }] },
  })

  it('conserva el orden, los tipos, las categorías y los niveles de chunking.py', () => {
    const fragmentos = fragmentarArticulo(aArticulo(completo))
    assert.deepEqual(tipos(fragmentos), [
      'required_data_must_have', 'required_data_nice_to_have', 'required_data_if_missing', 'required_data_disambiguation',
      'eligibility', 'critical_flags', 'decision_guide', 'response_frames', 'guardrails',
      'business_rules', 'business_rules', 'business_rules', 'steps', 'steps', 'steps',
      'common_issues', 'common_issues', 'common_issues', 'example', 'faqs', 'faqs', 'definitions', 'additional_notes', 'references',
    ])
    const nivel = (tipo: string, categoria?: string) => fragmentos.find(item => item.tipo === tipo && (!categoria || item.categoria === categoria))!.nivel
    assert.equal(nivel('required_data_must_have'), 'critical')
    assert.equal(nivel('required_data_nice_to_have'), 'medium')
    assert.equal(nivel('required_data_if_missing'), 'high')
    assert.equal(nivel('eligibility'), 'critical')
    assert.equal(nivel('business_rules', 'fees'), 'critical')
    assert.equal(nivel('business_rules', 'eligibility'), 'critical')
    assert.equal(nivel('business_rules', 'plazos'), 'high')
    assert.equal(nivel('steps'), 'high')
    assert.equal(nivel('example'), 'medium')
    assert.equal(nivel('faqs'), 'low')
    assert.equal(nivel('references'), 'low')
    // Pasos y FAQs se agrupan de tres en tres; las incidencias, por categoría.
    assert.deepEqual(fragmentos.filter(item => item.tipo === 'steps').map(item => item.categoria), ['steps_1_to_3', 'steps_4_to_6', 'steps_7_to_7'])
    assert.deepEqual(fragmentos.filter(item => item.tipo === 'faqs').map(item => item.categoria), ['group_1', 'group_2'])
    assert.deepEqual(fragmentos.filter(item => item.tipo === 'common_issues').map(item => item.categoria), ['access', 'process', 'technical'])
    for (const fragmento of fragmentos) assert.equal(fragmento.hash, createHash('md5').update(fragmento.texto).digest('hex').slice(0, 8))
    assert.deepEqual(fragmentos.map(item => item.indice), fragmentos.map((_, posicion) => posicion + 1))
  })

  it('cada fragmento conserva las rutas JSON de su origen', () => {
    const fragmentos = fragmentarArticulo(aArticulo(completo))
    assert.deepEqual(fragmentos.find(item => item.categoria === 'steps_4_to_6')!.rutas, ['details.steps[3]', 'details.steps[4]', 'details.steps[5]'])
    assert.deepEqual(fragmentos.find(item => item.tipo === 'eligibility')!.rutas, ['details.business_rules[0]'])
    assert.deepEqual(fragmentos.find(item => item.categoria === 'plazos')!.rutas, ['details.business_rules[2]'])
    assert.deepEqual(fragmentos.find(item => item.categoria === 'process')!.rutas, ['details.common_issues[1]'])
  })

  it('variantes del corpus: blocking_intent omitido, ask_participant null, fees omitido y enlaces en texto u objeto', () => {
    const fragmentos = fragmentarArticulo(aArticulo(completo))
    const imprescindibles = fragmentos.find(item => item.tipo === 'required_data_must_have')!
    assert.match(imprescindibles.texto, /\*\*Blocking intent:\*\* always/)
    assert.deepEqual(imprescindibles.extra, { must_have_blocking_intents: ['Saldo de la cuenta|always'] })
    const faltantes = fragmentos.find(item => item.tipo === 'required_data_if_missing')!.texto
    assert.doesNotMatch(faltantes, /Ask participant|None|null/)
    assert.match(faltantes, /\*\*Agent note:\*\* Consultarlo en el portal\./)
    assert.ok(!tipos(fragmentos).includes('fees_details'), 'sin fees no hay fragmento de cargos')
    const referencias = fragmentos.find(item => item.tipo === 'references')!.texto
    assert.match(referencias, /- Guía en texto/)
    assert.match(referencias, /- Formulario — https:\/\/ejemplo\.invalid\/f — Solicitar/)
    // additional_notes como lista de textos.
    const notas = fragmentarArticulo(aArticulo(articulo('n', 'N', { additional_notes: ['Primera nota del artículo.', 'Segunda nota.'] })))
    assert.deepEqual(notas.map(item => [item.tipo, item.categoria, item.rutas]), [['additional_notes', 'general', ['details.additional_notes']]])
  })

  it('J2: un paso con descripción y sin notas es contenido; nada se pierde entre fragmentos', () => {
    const datos = articulo('pasos', 'Pasos sin notas', {
      steps: [
        { step_number: 1, description: 'Abre el portal de gastos con tu usuario corporativo.', notes: null },
        { step_number: 2, description: 'Carga las facturas de la solicitud en formato electrónico.', notes: '' },
      ],
    })
    assert.equal(contenidoUtil(aArticulo(datos)), true)
    const fragmentos = fragmentarArticulo(aArticulo(datos))
    assert.equal(fragmentos.length, 1)
    assert.equal(fragmentos[0].texto, [
      '# Step-by-Step Procedure\n',
      '## Step 1: Abre el portal de gastos con tu usuario corporativo.',
      '',
      '## Step 2: Carga las facturas de la solicitud en formato electrónico.',
      '',
    ].join('\n'))
    assert.deepEqual(fragmentos[0].rutas, ['details.steps[0]', 'details.steps[1]'])
    // Un grupo cuyos pasos no tienen texto no produce un fragmento vacío.
    const vacios = articulo('vacios', 'Vacíos', { steps: [{ step_number: 1, description: '', notes: null }, { step_number: 2, description: '  ', notes: '' }] })
    assert.deepEqual(fragmentarArticulo(aArticulo(vacios)), [])
  })

  it('una regla larga se divide en partes de hasta 4000 caracteres sin perder ni duplicar texto', () => {
    const regla = Array.from({ length: 400 }, (_, indice) => `Marcador ${indice} de la regla larga.`).join(' ')
    const fragmentos = fragmentarArticulo(aArticulo(articulo('larga', 'Larga', { business_rules: [{ category: 'plazos', rules: [regla] }] })))
    assert.ok(fragmentos.length > 2)
    for (const [posicion, fragmento] of fragmentos.entries()) {
      assert.ok(fragmento.texto.length <= MAXIMO_FRAGMENTO, `${fragmento.texto.length}`)
      assert.deepEqual(fragmento.parte, [posicion + 1, fragmentos.length])
      if (posicion) assert.match(fragmento.texto, new RegExp(`^# Business Rules: Plazos \\(parte ${posicion + 1} de ${fragmentos.length}\\)\\n`))
    }
    const unido = normalizar(fragmentos.map(cuerpoDeParte).join(' '))
    assert.ok(unido.includes(normalizar(`- ${regla}`)))
    for (let indice = 0; indice < 400; indice++) assert.equal(unido.split(`Marcador ${indice} de`).length - 1, 1, `marcador ${indice}`)
  })

  it('J1: categorías y títulos enormes terminan y respetan el máximo (hilo con límite de tiempo)', async () => {
    const regla = 'Texto de la regla con contenido real. '.repeat(30)
    for (const categoria of ['x'.repeat(4100), 'y'.repeat(12_000), 'corta']) {
      const fragmentos = await fragmentarConLimite(articulo('categoria', 'Categoría', { business_rules: [{ category: categoria, rules: [regla] }] }))
      assert.ok(fragmentos.length >= 1, categoria.slice(0, 10))
      for (const fragmento of fragmentos) assert.ok(fragmento.texto.length <= MAXIMO_FRAGMENTO, `${fragmento.texto.length}`)
      const unido = normalizar(fragmentos.map(cuerpoDeParte).join(' '))
      assert.ok(unido.includes(normalizar(regla)), 'la regla llega completa')
      // El encabezado repetido se acota: no ocupa el espacio del contenido.
      for (const fragmento of fragmentos.slice(1)) assert.ok(fragmento.texto.split('\n')[0].length <= 200)
    }
    const titulo = await fragmentarConLimite(articulo('t', 'T'.repeat(LONGITUD_MAXIMA.title), { additional_notes: [{ category: 'z'.repeat(5000), notes: [regla] }] }))
    for (const fragmento of titulo) assert.ok(fragmento.texto.length <= MAXIMO_FRAGMENTO)
  })

  it('partir: el máximo efectivo nunca baja de 1 y siempre avanza', () => {
    assert.deepEqual(partir('abc', -50), ['a', 'b', 'c'])
    assert.deepEqual(partir('abc', 0), ['a', 'b', 'c'])
    assert.deepEqual(partir('uno dos', 4), ['uno', ' dos'])
    assert.deepEqual(partir('', 10), [''])
  })

  it('J3: claves ajenas al esquema no cuentan como contenido y no producen fragmentos', () => {
    const ajeno = aArticulo(articulo('ajeno', 'Ajeno', { dato_ajeno: 'Texto largo que no pertenece a ninguna sección del esquema kb_article_v2.' }))
    assert.equal(contenidoUtil(ajeno), false)
    assert.deepEqual(fragmentarArticulo(ajeno), [])
    // Solo banderas o secciones vacías tampoco son contenido útil.
    const banderas = aArticulo(articulo('banderas', 'Banderas', { critical_flags: { portal_required: true, mfa_relevant: true, record_keeper_must_be: 'LT Trust' }, steps: [], references: { participant_portal: null, contact: {}, internal_articles: [], external_links: [] } }))
    assert.equal(contenidoUtil(banderas), false)
    // Una sección conocida con claves desconocidas dentro solo cuenta por sus campos.
    const guiaAjena = aArticulo(articulo('guia', 'Guía', { decision_guide: { comentario_interno: 'Texto suficientemente largo para superar el mínimo de letras.' } }))
    assert.equal(contenidoUtil(guiaAjena), false)
    assert.deepEqual(fragmentarArticulo(guiaAjena), [])
  })
})

describe('Artículo canónico de extremo a extremo', () => {
  it('un artículo de demo produce fragmentos con contenido y su JSON original se conserva', async () => {
    const { VIATICOS_V1 } = await import('./support/demo-documentos.ts')
    const bytes = json(VIATICOS_V1)
    const { articulo: leido } = validarArchivoArticulo('Politica_Viaticos.json', bytes, MB)
    const fragmentos = fragmentarArticulo(leido)
    assert.ok(fragmentos.some(item => item.tipo === 'steps' && item.texto.includes('## Step 1: Ingresa al portal de gastos')))
    assert.deepEqual(JSON.parse(bytes.toString('utf8')), VIATICOS_V1)
  })
})
