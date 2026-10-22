import { expect, test } from '@playwright/test'
import { contratoInsuficiente, contratoRespuesta, contratoSinEvidencia, EJEMPLOS_PDF, ERRORES, PREGUNTA_ROLLOVER, PREGUNTA_VIATICOS, simularServidor } from './fixtures'

const resultados = (pregunta: string) => `/resultados?${new URLSearchParams({ q: pregunta })}`

test.describe('HU01 · realizar una consulta', () => {
  test('vacío o solo espacios no envía nada y pide escribir una pregunta', async ({ page }) => {
    const registro = await simularServidor(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'Buscar', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('Escribe una pregunta para comenzar.')
    await page.getByLabel('Escribe tu consulta').fill('     ')
    await page.getByLabel('Escribe tu consulta').press('Enter')
    await expect(page).toHaveURL(/\/$/)
    expect(registro.consultas).toHaveLength(0)
  })

  test('Buscar envía UNA solicitud, muestra el procesamiento y presenta el resultado sin recargar', async ({ page }) => {
    const registro = await simularServidor(page, { consulta: cuerpo => ({ status: 200, body: { ...contratoRespuesta, question: cuerpo.question }, retrasoMs: 700 }) })
    await page.goto('/')
    let recargas = 0
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) recargas++ })
    await page.getByLabel('Escribe tu consulta').fill(`  ${PREGUNTA_ROLLOVER}  `)
    await page.getByLabel('Escribe tu consulta').press('Enter')
    await expect(page.getByText('Consultando la base de conocimiento…')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    expect(registro.consultas.map(item => item.question)).toEqual([PREGUNTA_ROLLOVER])
    expect(registro.consultas[0].requestId).toMatch(/^req-[0-9a-f]{8}$/)
    expect(recargas).toBeLessThanOrEqual(1)
  })

  test('cada búsqueda nueva es independiente: repetir la pregunta envía otra solicitud, volver atrás no', async ({ page }) => {
    const registro = await simularServidor(page)
    await page.goto(resultados(PREGUNTA_ROLLOVER))
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    await page.getByRole('link', { name: 'Nueva consulta' }).click()
    await page.getByLabel('Escribe tu consulta').fill(PREGUNTA_ROLLOVER)
    await page.getByLabel('Escribe tu consulta').press('Enter')
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    expect(registro.consultas).toHaveLength(2)
    await page.goBack()
    await page.goBack()
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    expect(registro.consultas).toHaveLength(2)
    // Solo viaja la pregunta: ningún contexto de consultas anteriores.
    expect(new Set(registro.consultas.map(item => item.question))).toEqual(new Set([PREGUNTA_ROLLOVER]))
  })

  test('un error técnico o el tiempo agotado se informan y nunca muestran la respuesta anterior', async ({ page }) => {
    await simularServidor(page, { consulta: (_, intento) => (intento === 1 ? { status: 200, body: contratoRespuesta } : ERRORES.tiempo) })
    await page.goto(resultados(PREGUNTA_ROLLOVER))
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    await page.getByRole('link', { name: 'Nueva consulta' }).click()
    await page.getByLabel('Escribe tu consulta').fill(PREGUNTA_ROLLOVER)
    await page.getByLabel('Escribe tu consulta').press('Enter')
    await expect(page.getByRole('heading', { name: 'La consulta tardó demasiado' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Respuesta' })).toHaveCount(0)
    await expect(page.getByText('Para hacer un rollover')).toHaveCount(0)
    await expect(page.getByText('ID de soporte: req-9d2f41aa')).toBeVisible()
  })

  test('el ejemplo ejecuta el mismo flujo que escribir y pulsar Buscar', async ({ page }) => {
    const registro = await simularServidor(page)
    await page.goto('/')
    await page.getByRole('button', { name: EJEMPLOS_PDF[1], exact: true }).click()
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/resultados')
    expect(new URL(page.url()).searchParams.get('q')).toBe(EJEMPLOS_PDF[1])
    expect(registro.consultas.map(item => item.question)).toEqual([EJEMPLOS_PDF[1]])
  })
})

test.describe('HU03–HU05 · respuesta sustentada, fuentes y cobertura', () => {
  test('separa respuesta y puntos clave, muestra metadatos, cobertura explicada e ID de solicitud', async ({ page }) => {
    await simularServidor(page)
    await page.goto(resultados(PREGUNTA_ROLLOVER))
    const respuesta = page.getByRole('region', { name: 'Respuesta' })
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(PREGUNTA_ROLLOVER)
    await expect(page.getByText('18 fragmentos recuperados · 4 artículos · gpt-5.5')).toBeVisible()
    await expect(respuesta.getByText('Cobertura alta')).toBeVisible()
    await expect(respuesta.getByText(/no es una probabilidad de acierto/)).toBeVisible()
    await expect(respuesta.getByText('ID de solicitud: req-7f3a9c2e')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Puntos clave' })).toBeVisible()
    await expect(page.locator('.key-points li')).toHaveCount(5)
    await expect(page.locator('.source-card')).toHaveCount(4)
    await expect(page.locator('.source-card').first()).toContainText('Usado en la respuesta')
    await expect(page.locator('.source-card').first()).toContainText('Afinidad 0.62')
    await expect(page.locator('.source-card').first()).toContainText('5 fragmentos')
  })

  test('el título y la flecha de una fuente abren el mismo documento completo', async ({ page }) => {
    await simularServidor(page)
    await page.goto(resultados(PREGUNTA_ROLLOVER))
    const tarjeta = page.locator('.source-card').first()
    const titulo = tarjeta.locator('.source-title-link')
    const flecha = tarjeta.getByRole('link', { name: /Abrir el documento completo/ })
    await expect(titulo).toHaveAttribute('href', '/fuentes/terminated_distribution_options')
    await expect(flecha).toHaveAttribute('href', '/fuentes/terminated_distribution_options')
  })

  test('la insuficiencia no presenta texto generado y ofrece ver lo encontrado, reformular y contactar', async ({ page }) => {
    await simularServidor(page, { consulta: () => ({ status: 200, body: contratoInsuficiente }) })
    await page.goto(resultados(PREGUNTA_VIATICOS))
    const tarjeta = page.locator('.insufficient-card')
    await expect(tarjeta.getByText('Cobertura baja')).toBeVisible()
    await expect(tarjeta.getByText('1 de 5 fragmentos relevantes • 1 documento')).toBeVisible()
    await expect(tarjeta.getByText(/Documentación insuficiente\. No generamos una respuesta/)).toBeVisible()
    await expect(page.getByRole('region', { name: 'Respuesta' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Puntos clave' })).toHaveCount(0)
    await tarjeta.getByRole('button', { name: 'Ver documentos encontrados' }).click()
    await expect(tarjeta.locator('.source-card')).toHaveCount(1)
    await expect(tarjeta.locator('.source-card')).toContainText('Encontrado, sin evidencia suficiente')
    await tarjeta.getByRole('button', { name: 'Reformular consulta' }).click()
    await expect(tarjeta.getByLabel('Escribe tu pregunta')).toBeFocused()
    await expect(tarjeta.getByRole('link', { name: 'Contactar al área' })).toHaveAttribute('href', 'mailto:area.responsable@empresa.invalid')
  })

  test('sin evidencia no hay documentos que ver ni referencias inventadas', async ({ page }) => {
    await simularServidor(page, { consulta: () => ({ status: 200, body: contratoSinEvidencia }), estado: { contactoUrl: null } })
    await page.goto(resultados(PREGUNTA_VIATICOS))
    const tarjeta = page.locator('.insufficient-card')
    await expect(tarjeta.getByText('Sin evidencia')).toBeVisible()
    await expect(tarjeta.getByRole('button', { name: 'Ver documentos encontrados' })).toBeDisabled()
    await expect(tarjeta.getByRole('button', { name: 'Contactar al área' })).toBeDisabled()
    await expect(page.locator('.source-card')).toHaveCount(0)
  })

  test('la evidencia contradictoria se muestra con las fuentes implicadas', async ({ page }) => {
    await simularServidor(page, { consulta: () => ({ status: 200, body: { ...contratoRespuesta, contradictions: [{ description: 'Una fuente fija 15 días y otra 10 días hábiles.', source_ids: ['terminated_distribution_options', 'lt_split_rollover'] }] } }) })
    await page.goto(resultados(PREGUNTA_ROLLOVER))
    const bloque = page.getByRole('region', { name: 'Evidencia contradictoria' })
    await expect(bloque).toContainText('Una fuente fija 15 días y otra 10 días hábiles.')
    await expect(bloque).toContainText('LT: Can I Split My 401(k) Rollover Between Multiple Providers?')
  })
})

test.describe('HU10 · errores diferenciados con ID de soporte', () => {
  const casos = [
    ['recuperacion', 'No pudimos buscar en los documentos', 'req-c92e51f8'],
    ['baseVectorial', 'La base de conocimiento no está disponible', 'req-a03d77b2'],
    ['proveedor', 'No pudimos generar la respuesta', 'req-e58b19c4'],
    ['noDisponible', 'Un documento de la respuesta no está disponible', 'req-41c0de77'],
  ] as const
  for (const [clave, titulo, id] of casos) {
    test(`${clave}: tarjeta propia, ID de soporte y reintento con una solicitud nueva`, async ({ page }) => {
      const registro = await simularServidor(page, { consulta: (_, intento) => (intento === 1 ? ERRORES[clave] : { status: 200, body: contratoRespuesta }) })
      await page.goto(resultados(PREGUNTA_ROLLOVER))
      await expect(page.getByRole('heading', { name: titulo })).toBeVisible()
      await expect(page.getByText(`ID de soporte: ${id}`)).toBeVisible()
      await expect(page.getByRole('region', { name: 'Contrato JSON que recibe la interfaz' })).toContainText(`"code": "${ERRORES[clave].body.code}"`)
      await page.getByRole('button', { name: 'Reintentar' }).click()
      await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
      expect(registro.consultas).toHaveLength(2)
      expect(registro.consultas[0].requestId).not.toEqual(registro.consultas[1].requestId)
    })
  }

  test('validación: la pregunta corta la rechaza el servidor y se corrige desde la misma pantalla', async ({ page }) => {
    await simularServidor(page, { consulta: cuerpo => (cuerpo.question.length < 10 ? ERRORES.validacion : { status: 200, body: contratoRespuesta }) })
    await page.goto(resultados('hola'))
    await expect(page.getByRole('heading', { name: 'La pregunta no es válida' })).toBeVisible()
    await expect(page.getByText('Revisa el texto: necesita al menos 10 caracteres.')).toBeVisible()
    await expect(page.getByText('ID de soporte: req-1b44d0a7')).toBeVisible()
    await page.getByRole('button', { name: 'Corregir pregunta' }).click()
    await expect(page.getByLabel('Escribe tu pregunta')).toBeFocused()
    await page.getByLabel('Escribe tu pregunta').fill('')
    await page.getByRole('button', { name: 'Consultar' }).click()
    await expect(page.getByText('Escribe una pregunta para consultar.')).toBeVisible()
    await expect(page.getByText('Sin ID de soporte: la solicitud no se envió.')).toBeVisible()
  })

  test('sin conexión con el servidor se informa sin inventar un ID de soporte del servidor', async ({ page }) => {
    await simularServidor(page)
    await page.route('**/api/consulta', route => route.abort('connectionrefused'))
    await page.goto(resultados(PREGUNTA_ROLLOVER))
    await expect(page.getByRole('heading', { name: 'No hay conexión con Knowledge Desk' })).toBeVisible()
    await expect(page.getByText(/ID de soporte: req-[0-9a-f]{8}/)).toBeVisible()
  })
})

test.describe('Caché de navegación y cambios del corpus', () => {
  test('volver a una respuesta sin cambios no repite la consulta; tras un cambio en los documentos sí', async ({ page }) => {
    const servidor = await simularServidor(page)
    await page.goto(resultados(PREGUNTA_ROLLOVER))
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    await page.getByRole('link', { name: 'Documentos', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Documentos de la base de conocimiento' })).toBeVisible()
    await page.goBack()
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    expect(servidor.consultas).toHaveLength(1)

    // Alguien carga, reemplaza o elimina un documento: la revisión del corpus sube.
    servidor.revision = 2
    await page.getByRole('link', { name: 'Documentos', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Documentos de la base de conocimiento' })).toBeVisible()
    await page.goBack()
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    expect(servidor.consultas, 'la respuesta anterior al cambio no se reutiliza').toHaveLength(2)
  })

  test('U1: si el corpus cambia mientras se responde, la respuesta vieja se descarta y se pregunta una sola vez más', async ({ page }) => {
    const servidor = await simularServidor(page, {
      revision: 5,
      estadoRetrasoMs: 250,
      consulta: (cuerpo, intento) => ({ status: 200, retrasoMs: intento === 1 ? 900 : 0, body: { ...contratoRespuesta, question: cuerpo.question, request_id: `req-0000000${intento}`, corpus_revision: intento === 1 ? 4 : 5 } }),
    })
    await page.goto(resultados(PREGUNTA_ROLLOVER))
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    await expect(page.getByText('ID de solicitud: req-00000002')).toBeVisible()
    expect(servidor.consultas).toHaveLength(2)
  })

  test('U1: tres respuestas de un corpus anterior no se presentan ni quedan en caché: error con reintento explícito', async ({ page }) => {
    let revisionRespuestas = 4
    const servidor = await simularServidor(page, {
      revision: 5,
      consulta: (cuerpo, intento) => ({ status: 200, retrasoMs: intento === 1 ? 600 : 0, body: { ...contratoRespuesta, question: cuerpo.question, request_id: `req-0000000${intento}`, corpus_revision: revisionRespuestas } }),
    })
    await page.goto(resultados(PREGUNTA_ROLLOVER))
    await expect(page.getByRole('heading', { name: 'La documentación cambió durante la consulta' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Respuesta' })).toHaveCount(0)
    await page.waitForTimeout(400)
    expect(servidor.consultas, 'reintentos limitados, sin bucle').toHaveLength(3)

    // Volver a la entrada no reutiliza ninguna respuesta vieja.
    await page.getByRole('link', { name: 'Documentos', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Documentos de la base de conocimiento' })).toBeVisible()
    await page.goBack()
    await expect(page.getByRole('heading', { name: 'La documentación cambió durante la consulta' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Respuesta' })).toHaveCount(0)

    // El reintento explícito obtiene una respuesta del corpus vigente.
    revisionRespuestas = 5
    await page.getByRole('button', { name: 'Reintentar' }).click()
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    expect(servidor.consultas).toHaveLength(4)
  })

  test('U2: con la señal ya cancelada, pedir() no envía ninguna petición', async ({ page }) => {
    await simularServidor(page)
    await page.goto('/')
    const resultado = await page.evaluate(async modulo => {
      const { pedir } = await import(modulo) as typeof import('../../src/api/cliente')
      let llamadas = 0
      const original = window.fetch
      window.fetch = (...argumentos) => { llamadas++; return original(...argumentos) }
      const controlador = new AbortController()
      controlador.abort()
      try {
        await pedir('/api/estado', { signal: controlador.signal })
        return { llamadas, code: 'sin error' }
      } catch (error) {
        return { llamadas, code: (error as { code: string }).code }
      } finally {
        window.fetch = original
      }
    }, '/src/api/cliente.ts')
    expect(resultado).toEqual({ llamadas: 0, code: 'ABORTED' })
  })

  test('U3: al volver a la pestaña se revalida el corpus y una respuesta de un corpus anterior no se reutiliza', async ({ page }) => {
    const servidor = await simularServidor(page)
    await page.goto(resultados(PREGUNTA_ROLLOVER))
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    servidor.revision = 2 // otro operador cambió un documento
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => servidor.consultas.length).toBe(2)
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
  })

  test('U3: antes de reutilizar una respuesta al volver atrás se comprueba la revisión', async ({ page }) => {
    const servidor = await simularServidor(page)
    await page.goto(resultados(PREGUNTA_ROLLOVER))
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    await page.getByRole('link', { name: 'Nueva consulta' }).click()
    await expect(page.getByLabel('Escribe tu consulta')).toBeVisible()
    servidor.revision = 3 // sin evento alguno en esta pestaña
    await page.goBack()
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    expect(servidor.consultas).toHaveLength(2)
  })

  test('U3: si no se puede comprobar el corpus al volver, la respuesta guardada no se muestra y se ofrece reintentar', async ({ page }) => {
    const servidor = await simularServidor(page)
    await page.goto(resultados(PREGUNTA_ROLLOVER))
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    await page.getByRole('link', { name: 'Nueva consulta' }).click()
    await expect(page.getByLabel('Escribe tu consulta')).toBeVisible()
    servidor.estadoFalla = true
    await page.goBack()
    await expect(page.getByRole('heading', { name: 'No hay conexión con Knowledge Desk' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Respuesta' })).toHaveCount(0)
    expect(servidor.consultas).toHaveLength(1)
    servidor.estadoFalla = false
    await page.getByRole('button', { name: 'Reintentar' }).click()
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    expect(servidor.consultas).toHaveLength(2)
  })

  test('U3: un cambio del corpus visto en otra pestaña invalida la respuesta de esta', async ({ context }) => {
    const servidor = await simularServidor(context)
    const primera = await context.newPage()
    await primera.goto(resultados(PREGUNTA_ROLLOVER))
    await expect(primera.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    servidor.revision = 4
    const segunda = await context.newPage()
    await segunda.goto('/documentos')
    await expect(segunda.getByRole('heading', { name: 'Documentos de la base de conocimiento' })).toBeVisible()
    await expect.poll(() => servidor.consultas.length).toBe(2)
    await expect(primera.getByRole('region', { name: 'Respuesta' })).toBeVisible()
  })
})

test.describe('Accesibilidad y diseño adaptable', () => {
  test('el estado se anuncia, el foco vuelve al contenido y el teclado alcanza los controles', async ({ page }) => {
    await simularServidor(page, { consulta: cuerpo => ({ status: 200, body: { ...contratoRespuesta, question: cuerpo.question }, retrasoMs: 500 }) })
    await page.goto(resultados(PREGUNTA_ROLLOVER))
    await expect(page.getByRole('status').first()).toHaveText('Consultando la base de conocimiento. Puede tardar unos segundos.')
    await expect(page.getByRole('status').first()).toHaveText('Respuesta lista.')
    await expect(page.locator('main')).toBeFocused()
    await page.goto('/')
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'Saltar al contenido' })).toBeFocused()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    await expect(page.getByLabel('Escribe tu consulta')).toBeFocused()
  })

  test('ninguna pantalla de consulta desborda el ancho del viewport', async ({ page }) => {
    await simularServidor(page, { consulta: cuerpo => (cuerpo.question.includes('viáticos') ? { status: 200, body: contratoInsuficiente } : cuerpo.question === 'hola' ? ERRORES.validacion : { status: 200, body: contratoRespuesta }) })
    for (const ruta of ['/', resultados(PREGUNTA_ROLLOVER), resultados(PREGUNTA_VIATICOS), resultados('hola')]) {
      await page.goto(ruta)
      await page.waitForLoadState('networkidle')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), ruta).toBe(true)
    }
  })
})
