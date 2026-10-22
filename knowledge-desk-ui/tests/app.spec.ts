import { expect, test } from '@playwright/test'
import { suggestions } from '../src/data/questions'
import { ENDPOINT, answerFixture, limitedFixture, stubAnswer } from './fixtures'

const question = '¿Qué es un retiro por dificultad económica y quién califica?'
const firstSource = answerFixture.source_articles[0].article_title

test('inicio, validación y búsqueda por Enter', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await stubAnswer(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('¿Qué necesitas saber?')
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: testInfo.outputPath('consulta.png'), fullPage: true })
  await page.getByRole('button', { name: 'Buscar', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Escribe una pregunta para comenzar.')
  await page.getByLabel('Escribe tu consulta').fill('    ')
  await page.getByLabel('Escribe tu consulta').press('Enter')
  await expect(page).toHaveURL(/\/$/)
  await page.getByLabel('Escribe tu consulta').fill('nómina')
  await page.getByLabel('Escribe tu consulta').press('Enter')
  await expect(page.getByRole('alert')).toHaveText('La pregunta necesita al menos 10 caracteres.')
  await expect(page).toHaveURL(/\/$/)
  await page.getByLabel('Escribe tu consulta').fill(`  ${question}  `)
  await page.getByLabel('Escribe tu consulta').press('Enter')
  await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
  expect(new URL(page.url()).searchParams.get('q')).toBe(question)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(question)
  expect(errors).toEqual([])
})

test('la respuesta muestra cobertura, puntos clave y fuentes reales', async ({ page }, testInfo) => {
  await stubAnswer(page)
  await page.goto(`/resultados?${new URLSearchParams({ q: question })}`)
  const answer = page.getByRole('region', { name: 'Respuesta' })
  await expect(answer).toBeVisible()
  await expect(answer.getByText('Cobertura alta')).toBeVisible()
  await expect(answer.getByText('Requisitos principales:')).toBeVisible()
  await expect(answer.locator('.rich-list li')).toHaveCount(2)
  await expect(page.getByText('3 fragmentos recuperados · 2 artículos · gpt-5.5')).toBeVisible()
  await expect(page.locator('.key-points li')).toHaveCount(2)
  await expect(page.locator('.source-card')).toHaveCount(2)
  await expect(page.locator('.source-card').first()).toContainText('Usado en la respuesta')
  await expect(page.locator('.source-card').first()).toContainText('2 fragmentos')
  await expect(page.locator('.source-card').last()).toContainText('Apoyo')
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: testInfo.outputPath('resultados.png'), fullPage: true })
})

test('el diálogo muestra los fragmentos recuperados y devuelve el foco', async ({ page }) => {
  await stubAnswer(page)
  await page.goto(`/resultados?${new URLSearchParams({ q: question })}`)
  const source = page.locator('.source-card').filter({ hasText: firstSource })
  await source.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('2 fragmentos recuperados del índice')
  await expect(dialog.locator('.fragment')).toHaveCount(2)
  await expect(dialog).toContainText('Fragmento 1 · Afinidad 0.60')
  await expect(dialog).toContainText('necesidad urgente e inmediata')
  // Los bloques operativos del artículo no se muestran en la consulta.
  await expect(dialog).not.toContainText('Decision Guide')
  await expect(dialog).not.toContainText('can_proceed')
  await expect(dialog).not.toContainText('Required Data')
  await expect(dialog).not.toContainText('participant_id')
  await expect(dialog.getByRole('button', { name: 'Cerrar fuente' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: 'Volver a la respuesta' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(source).toBeFocused()
  await source.click()
  await page.getByRole('button', { name: 'Volver a la respuesta' }).click()
  await expect(dialog).not.toBeVisible()
})

test('la fuente abierta no reaparece sobre otra consulta', async ({ page }) => {
  await stubAnswer(page)
  await page.goto('/resultados')
  await page.getByRole('link', { name: suggestions[0], exact: true }).click()
  await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
  await page.locator('.source-card').first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Comienza con una pregunta' })).toBeVisible()
  await page.getByRole('link', { name: suggestions[1], exact: true }).click()
  await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('el estado de carga precede a la respuesta y no se repite la llamada', async ({ page }) => {
  let calls = 0
  await stubAnswer(page, { delayMs: 800, onCall: count => { calls = count } })
  await page.goto(`/resultados?${new URLSearchParams({ q: question })}`)
  await expect(page.getByText('Consultando la base de conocimiento…')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
  await expect(page.getByText('Consultando la base de conocimiento…')).toHaveCount(0)
  await page.getByRole('link', { name: 'Nueva consulta' }).click()
  await page.goBack()
  await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
  expect(calls).toBe(1)
})

test('un fallo de la API se explica y permite reintentar', async ({ page }) => {
  let calls = 0
  await page.route(ENDPOINT, async route => {
    calls += 1
    if (calls === 1) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'fallo simulado' }) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answerFixture) })
  })
  await page.goto(`/resultados?${new URLSearchParams({ q: question })}`)
  const failure = page.locator('.answer-failure')
  await expect(failure).toContainText('No pudimos responder')
  await expect(failure).toContainText('fallo simulado')
  await page.getByRole('button', { name: 'Reintentar' }).click()
  await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
  expect(calls).toBe(2)
})

test('cobertura limitada, consulta corta y ruta sin pregunta', async ({ page }) => {
  await stubAnswer(page, { body: limitedFixture })
  await page.goto(`/resultados?${new URLSearchParams({ q: question })}`)
  await expect(page.getByText('Cobertura limitada')).toBeVisible()
  await expect(page.locator('.key-points')).toHaveCount(0)
  await page.goto('/resultados?q=corta')
  await expect(page.getByRole('heading', { name: 'Revisa tu consulta' })).toBeVisible()
  await expect(page.locator('.empty-results')).toContainText('La pregunta necesita al menos 10 caracteres.')
  await expect(page.getByRole('status')).toHaveText('La pregunta necesita al menos 10 caracteres.')
  await expect(page.getByRole('region', { name: 'Respuesta' })).toHaveCount(0)
  await page.goto('/resultados')
  await expect(page.getByRole('heading', { name: 'Comienza con una pregunta' })).toBeVisible()
})

test('las sugerencias consultan la API y permiten volver', async ({ page }) => {
  const asked: string[] = []
  await page.route(ENDPOINT, async route => {
    asked.push(JSON.parse(route.request().postData() ?? '{}').question)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answerFixture) })
  })
  await page.goto('/')
  for (const suggestion of suggestions) {
    await page.getByRole('button', { name: suggestion, exact: true }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(suggestion)
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Fuentes documentales' })).toBeVisible()
    await page.getByRole('link', { name: 'Nueva consulta' }).click()
    await expect(page.getByLabel('Escribe tu consulta')).toBeVisible()
  }
  expect(asked).toEqual(suggestions)
})

test('el fallo interno que el backend devuelve con estado 200 no se pinta como respuesta', async ({ page }) => {
  await stubAnswer(page, {
    body: {
      answer: 'An internal error occurred while processing your question.',
      key_points: [],
      source_articles: [],
      used_chunks: [],
      confidence_note: 'limited_coverage',
      metadata: { error: 'knowledge_question_failed', retrieval_failure_kind: 'timeout', chunks_used: 0 },
    },
  })
  await page.goto(`/resultados?${new URLSearchParams({ q: question })}`)
  await expect(page.locator('.answer-failure')).toContainText('No pudimos responder')
  await expect(page.getByRole('region', { name: 'Respuesta' })).toHaveCount(0)
  await expect(page.getByText('An internal error occurred')).toHaveCount(0)
})

test('la respuesta anuncia su estado a un lector de pantalla', async ({ page }) => {
  await stubAnswer(page, { delayMs: 600 })
  await page.goto(`/resultados?${new URLSearchParams({ q: question })}`)
  const status = page.getByRole('status')
  await expect(status).toHaveText('Consultando la base de conocimiento. Puede tardar unos segundos.')
  await expect(status).toHaveText('Respuesta lista.')
  await expect(page.locator('main')).toBeFocused()
})

test('el texto del modelo conserva las listas aunque no haya línea en blanco', async ({ page }) => {
  // Forma dominante en las respuestas reales: encabezado o frase de entrada y
  // sus viñetas pegadas, con sub-viñetas sangradas.
  await stubAnswer(page, {
    body: {
      ...answerFixture,
      answer: '### Umbrales del force-out\nEstos son los tramos que fija el índice:\n1. **80 dólares o menos**: se cierra la cuenta.\n   - No se transfiere nada al participante.\n2. Entre 80 y 1000 dólares: puede haber distribución en efectivo.\n\nCierre del apartado.',
    },
  })
  await page.goto(`/resultados?${new URLSearchParams({ q: question })}`)
  const prose = page.locator('.answer-prose')
  await expect(prose.locator('ol > li')).toHaveCount(2)
  await expect(prose.locator('ol > li ul > li')).toHaveCount(1)
  await expect(prose.getByText('Umbrales del force-out')).toBeVisible()
  await expect(prose.locator('p', { hasText: 'Cierre del apartado.' })).toBeVisible()
  // Ningún marcador de markdown queda visible como texto.
  const texts = await prose.locator('p, li').allTextContents()
  expect(texts.filter(text => /^\s*([-*•]\s|#{1,6}\s|\d+[.)]\s)/.test(text))).toEqual([])
})

test('documentos, filtro y estado sin coincidencias', async ({ page }, testInfo) => {
  await page.goto('/documentos')
  await expect(page.locator('tbody tr')).toHaveCount(5)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: testInfo.outputPath('documentos.png'), fullPage: true })
  await page.getByLabel('Buscar documentos por nombre').fill('PRIVACIDAD')
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await expect(page.locator('tbody')).toContainText('Politica_Privacidad_2023.pdf')
  await page.getByLabel('Buscar documentos por nombre').fill('archivo inexistente')
  await expect(page.getByText('No hay documentos que coincidan con tu búsqueda.')).toBeVisible()
  await page.getByLabel('Buscar documentos por nombre').fill('')
  await expect(page.locator('tbody tr')).toHaveCount(5)
})

test('selección de archivos, simulación y continuidad de sesión', async ({ page }) => {
  const sent: string[] = []
  page.on('request', request => { if (request.method() === 'POST') sent.push(request.url()) })
  await page.goto('/documentos')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Explorar archivos' }).click()
  const chooser = await chooserPromise
  await chooser.setFiles([
    { name: 'Documento_de_prueba.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic test') },
    { name: 'Notas.txt', mimeType: 'text/plain', buffer: Buffer.from('Datos de prueba') },
    { name: 'Manual.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('Synthetic fixture, not parsed') },
  ])
  await expect(page.getByText('3 documentos añadidos a la demostración.')).toBeVisible()
  const uploaded = page.locator('tbody tr').filter({ hasText: 'Documento_de_prueba.pdf' })
  await expect(uploaded).toContainText('Procesando')
  await page.getByRole('link', { name: 'Consulta', exact: true }).click()
  await page.getByRole('link', { name: 'Documentos', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(8)
  await expect(uploaded).toContainText('Indexado · demo')
  expect(sent).toEqual([])
  await page.reload()
  await expect(page.locator('tbody tr')).toHaveCount(5)
})

test('arrastre y rechazo de formato, vacío y tamaño excesivo', async ({ page }) => {
  await page.goto('/documentos')
  const data = await page.evaluateHandle(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['Prueba de arrastre'], 'Arrastrado.TXT', { type: 'text/plain' }))
    transfer.items.add(new File(['test'], 'Imagen.png', { type: 'image/png' }))
    transfer.items.add(new File([], 'Vacio.pdf', { type: 'application/pdf' }))
    transfer.items.add(new File([new Uint8Array(50 * 1024 * 1024 + 1)], 'Excesivo.pdf', { type: 'application/pdf' }))
    return transfer
  })
  await page.locator('.upload-zone').dispatchEvent('dragenter', { dataTransfer: data })
  await expect(page.locator('.upload-zone')).toHaveClass(/is-dragging/)
  await page.locator('.upload-zone').dispatchEvent('drop', { dataTransfer: data })
  await data.dispose()
  await expect(page.locator('tbody tr')).toHaveCount(6)
  await expect(page.getByRole('alert')).toContainText('formato no admitido')
  await expect(page.getByRole('alert')).toContainText('el archivo está vacío')
  await expect(page.getByRole('alert')).toContainText('supera el límite de 50 MB')
  await expect(page.locator('.upload-zone')).not.toHaveClass(/is-dragging/)
})

test('navegación por teclado, sesión y foco visible', async ({ page }) => {
  await page.goto('/')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Saltar al contenido' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('main')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Escribe tu consulta')).toBeFocused()
  await page.keyboard.press('Tab')
  const search = page.getByRole('button', { name: 'Buscar', exact: true })
  await expect(search).toBeFocused()
  expect(await search.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid')
  const user = page.getByRole('button', { name: 'Sesión de usuario' })
  await user.click()
  await expect(page.getByRole('region', { name: 'Información de la sesión' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(user).toBeFocused()
  await expect(user).toHaveAttribute('aria-expanded', 'false')
})

test('las tres rutas no desbordan el viewport', async ({ page }) => {
  await stubAnswer(page)
  for (const route of ['/', `/resultados?${new URLSearchParams({ q: question })}`, '/documentos']) {
    await page.goto(route)
    await page.evaluate(() => document.fonts.ready)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expect(page.getByRole('link', { name: 'Consulta', exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Documentos', exact: true })).toBeVisible()
  }
})

test('ruta desconocida permite volver al inicio', async ({ page }) => {
  await page.goto('/no-existe')
  await expect(page.getByRole('heading', { name: 'Página no encontrada' })).toBeVisible()
  await page.getByRole('link', { name: 'Volver a Consulta' }).click()
  await expect(page.getByRole('heading', { name: '¿Qué necesitas saber?' })).toBeVisible()
})
