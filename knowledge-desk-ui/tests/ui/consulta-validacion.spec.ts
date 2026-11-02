import { expect, test, type Page } from '@playwright/test'
import { contratoCasoVacaciones, errorContrato, FRASE_VACACIONES, PREGUNTA_REPORTADA, simularServidor } from './fixtures'

// Longitud de la pregunta: de 10 a 100 caracteres, contados como el servidor
// (sin los espacios de los extremos y por puntos de código). El navegador no
// envía una pregunta fuera de rango ni recorta el texto pegado.
const resultados = (pregunta: string) => `/resultados?${new URLSearchParams({ q: pregunta })}`
const EMOJI = '\u{1F600}' // un carácter, dos unidades UTF-16
const caracteres = (texto: string) => Array.from(texto).length
const campoInicio = (page: Page) => page.getByLabel('Escribe tu consulta')
const LARGA = (n: number) => `La pregunta tiene ${n} caracteres y el máximo es 100. Acórtala para consultar.`

test.describe('Límites de la pregunta en la URL directa', () => {
  const casos: [string, string, string, string][] = [
    ['corta en ASCII', 'hola', 'La pregunta necesita al menos 10 caracteres; tiene 4.', 'Revisa el texto: necesita al menos 10 caracteres.'],
    ['corta con espacios en los extremos', `   ${'a'.repeat(9)}   `, 'La pregunta necesita al menos 10 caracteres; tiene 9.', 'Revisa el texto: necesita al menos 10 caracteres.'],
    ['corta con emoji', EMOJI.repeat(9), 'La pregunta necesita al menos 10 caracteres; tiene 9.', 'Revisa el texto: necesita al menos 10 caracteres.'],
    ['de 101 caracteres en ASCII', 'a'.repeat(101), LARGA(101), 'Revisa el texto: no puede superar 100 caracteres.'],
    ['de 101 caracteres con ñ', 'ñ'.repeat(101), LARGA(101), 'Revisa el texto: no puede superar 100 caracteres.'],
    ['de 101 emojis', EMOJI.repeat(101), LARGA(101), 'Revisa el texto: no puede superar 100 caracteres.'],
    ['reportada (frase repetida, 1036 caracteres)', PREGUNTA_REPORTADA, LARGA(1036), 'Revisa el texto: no puede superar 100 caracteres.'],
  ]
  for (const [nombre, pregunta, mensaje, tarjeta] of casos) {
    test(`${nombre}: no llama al servidor y explica el motivo`, async ({ page }) => {
      const registro = await simularServidor(page)
      await page.goto(resultados(pregunta))
      await expect(page.getByRole('heading', { name: 'La pregunta no es válida' })).toBeVisible()
      await expect(page.getByRole('alert')).toHaveText(mensaje)
      await expect(page.getByText(tarjeta)).toBeVisible()
      await expect(page.getByText('Sin ID de soporte: la solicitud no se envió.')).toBeVisible()
      // El texto queda completo en el campo para corregirlo.
      expect(caracteres(await page.getByLabel('Escribe tu pregunta').inputValue())).toBe(caracteres(pregunta.trim()))
      expect(registro.consultas).toHaveLength(0)
    })
  }

  test('en los límites (10, 99 y 100, también con emoji) se envía la pregunta completa', async ({ page }) => {
    const registro = await simularServidor(page)
    const validas = ['a'.repeat(10), 'a'.repeat(99), 'a'.repeat(100), EMOJI.repeat(100), FRASE_VACACIONES]
    for (const pregunta of validas) {
      await page.goto(resultados(pregunta))
      await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    }
    expect(registro.consultas.map(consulta => consulta.question)).toEqual(validas)
  })

  test('una URL demasiado larga la rechaza el servidor HTTP sin cargar la aplicación ni consultar', async ({ page }) => {
    const registro = await simularServidor(page)
    // 2000 emojis codificados ocupan unos 24 KB: Node responde 431 antes de servir la interfaz.
    const respuesta = await page.goto(resultados(EMOJI.repeat(2000)))
    expect(respuesta?.status()).toBe(431)
    expect(registro.consultas).toHaveLength(0)
  })
})

test.describe('Límites de la pregunta en el formulario', () => {
  test('un texto pegado de más de 100 caracteres no se recorta, el indicador lo marca y no se envía', async ({ page }) => {
    const registro = await simularServidor(page)
    await page.goto('/')
    await campoInicio(page).fill('x'.repeat(150))
    expect(await campoInicio(page).inputValue()).toHaveLength(150)
    await expect(page.getByText('150 de 100 caracteres')).toHaveClass(/question-counter-over/)
    await page.getByRole('button', { name: 'Buscar', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText(LARGA(150))
    await expect(page).toHaveURL(/\/$/)
    expect(registro.consultas).toHaveLength(0)
  })

  test('cuenta caracteres y no unidades UTF-16: 100 emojis se envían completos y 101 se rechazan', async ({ page }) => {
    const registro = await simularServidor(page)
    await page.goto('/')
    await campoInicio(page).fill(EMOJI.repeat(101))
    await expect(page.getByText('101 de 100 caracteres')).toBeVisible()
    await page.getByRole('button', { name: 'Buscar', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText(LARGA(101))
    await campoInicio(page).fill(EMOJI.repeat(100))
    await expect(page.getByText('100 de 100 caracteres')).not.toHaveClass(/question-counter-over/)
    await page.getByRole('button', { name: 'Buscar', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    expect(registro.consultas.map(consulta => consulta.question)).toEqual([EMOJI.repeat(100)])
  })

  test('la pregunta reportada se rechaza sin enviarse y la frase de 100 caracteres se consulta', async ({ page }) => {
    const registro = await simularServidor(page)
    await page.goto('/')
    await campoInicio(page).fill('Vacación')
    await page.getByRole('button', { name: 'Buscar', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('La pregunta necesita al menos 10 caracteres; tiene 8.')
    await campoInicio(page).fill(PREGUNTA_REPORTADA)
    await page.getByRole('button', { name: 'Buscar', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText(LARGA(1036))
    expect(registro.consultas).toHaveLength(0)
    await campoInicio(page).fill(FRASE_VACACIONES)
    await page.getByRole('button', { name: 'Buscar', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Respuesta' })).toBeVisible()
    expect(registro.consultas.map(consulta => consulta.question)).toEqual([FRASE_VACACIONES])
  })
})

test.describe('Caso reportado: respuesta del motor sin sustento', () => {
  test('la insuficiencia no presenta respuesta generada ni fuentes como sustento', async ({ page }) => {
    const registro = await simularServidor(page, { consulta: () => ({ status: 200, body: contratoCasoVacaciones }) })
    await page.goto(resultados(FRASE_VACACIONES))
    await expect(page.getByRole('heading', { name: 'Asistente de documentación interna' })).toBeVisible()
    await expect(page.getByText('El servicio de consulta declaró que la documentación recuperada no cubre partes de la pregunta.')).toBeVisible()
    await expect(page.getByText(/Documentación insuficiente\. No generamos una respuesta/)).toBeVisible()
    await expect(page.getByRole('region', { name: 'Respuesta' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Fuentes documentales' })).toHaveCount(0)
    await expect(page.getByText('Usado en la respuesta')).toHaveCount(0)
    await expect(page.getByRole('main')).not.toContainText('No puedo indicar')
    expect(registro.consultas).toHaveLength(1)
  })

  test('un rechazo HTTP 401 de ForUsGuide es un error de configuración, no una insuficiencia', async ({ page }) => {
    await simularServidor(page, {
      consulta: () => errorContrato('UPSTREAM_AUTH_ERROR', 'El servicio de consulta rechazó la credencial del servidor. Avisa al administrador.', 'req-7c0a9e15', 502, { retryable: false, upstream_status: 401 }),
    })
    await page.goto(resultados(FRASE_VACACIONES))
    await expect(page.getByRole('heading', { name: 'El servicio de consulta rechazó la configuración' })).toBeVisible()
    await expect(page.getByText('ID de soporte: req-7c0a9e15')).toBeVisible()
    await expect(page.getByText(/Documentación insuficiente/)).toHaveCount(0)
  })
})
