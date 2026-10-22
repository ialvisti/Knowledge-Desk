import type { Page, Route } from '@playwright/test'

export const ENDPOINT = '**/api/v1/knowledge-question'

// Copia recortada de una respuesta real del endpoint, para que las pruebas no
// dependan del índice ni gasten llamadas al modelo.
export const answerFixture = {
  answer: 'Un retiro por dificultad económica es una distribución del 401(k) que el plan puede permitir ante una necesidad urgente.\n\n**Requisitos principales:** el motivo debe encajar en una de las categorías aprobadas y el monto se limita a lo necesario.\n\n- El plan debe permitir este tipo de retiro.\n- La documentación de respaldo se conserva para una posible auditoría.',
  key_points: [
    'El motivo debe coincidir con una categoría aprobada.',
    'El monto no puede superar la necesidad documentada.',
  ],
  source_articles: [
    {
      article_id: 'hardship_guide',
      article_title: 'ForUsAll 401(k) Hardship Withdrawal — Complete Guide',
      chunk_types_used: 'faqs, steps',
      relevance: 'Covers hardship_withdrawal',
      used_info: true,
      max_score: 0.6005,
    },
    {
      article_id: 'in_service',
      article_title: 'Can I Take Money From My 401(k) While Employed?',
      chunk_types_used: 'faqs',
      relevance: 'Covers in_service_withdrawal_options',
      used_info: false,
      max_score: 0.41,
    },
  ],
  used_chunks: [
    {
      chunk_id: 'hardship_guide_chunk_25',
      score: 0.6005,
      chunk_type: 'faqs',
      chunk_tier: 'low',
      article_id: 'hardship_guide',
      article_title: 'ForUsAll 401(k) Hardship Withdrawal — Complete Guide',
      content_preview: 'Un retiro por dificultad económica es una distribución...',
      content: 'Un retiro por dificultad económica es una distribución del 401(k) que el plan puede permitir ante una necesidad urgente e inmediata.',
    },
    {
      chunk_id: 'hardship_guide_chunk_08',
      score: 0.52,
      chunk_type: 'steps',
      chunk_tier: 'high',
      article_id: 'hardship_guide',
      article_title: 'ForUsAll 401(k) Hardship Withdrawal — Complete Guide',
      content_preview: 'El participante presenta la solicitud...',
      content: 'El participante presenta la solicitud y conserva los documentos que acreditan el gasto.',
    },
    {
      chunk_id: 'hardship_guide_chunk_31',
      score: 0.49,
      chunk_type: 'decision_guide',
      chunk_tier: 'critical',
      article_id: 'hardship_guide',
      article_title: 'ForUsAll 401(k) Hardship Withdrawal — Complete Guide',
      content_preview: '# Decision Guide...',
      content: '# Decision Guide\n\n## Supported Outcomes:\n- can_proceed\n- blocked_not_eligible',
    },
    {
      chunk_id: 'hardship_guide_chunk_44',
      score: 0.47,
      chunk_type: 'required_data_must_have',
      chunk_tier: 'critical',
      article_id: 'hardship_guide',
      article_title: 'ForUsAll 401(k) Hardship Withdrawal — Complete Guide',
      content_preview: '# Required Data: Must Have...',
      content: '# Required Data: Must Have\n- participant_id\n- hardship_reason',
    },
    {
      chunk_id: 'in_service_chunk_03',
      score: 0.41,
      chunk_type: 'faqs',
      chunk_tier: 'medium',
      article_id: 'in_service',
      article_title: 'Can I Take Money From My 401(k) While Employed?',
      content_preview: 'Existen varias opciones mientras sigues empleado...',
      content: 'Existen varias opciones mientras sigues empleado, y cada una tiene sus propias reglas.',
    },
  ],
  confidence_note: 'well_covered',
  metadata: { chunks_used: 3, unique_articles: 2, model: 'gpt-5.5', sub_queries: ['hardship withdrawal eligibility'] },
}

export const limitedFixture = {
  ...answerFixture,
  answer: 'No tengo suficiente información en el contexto recuperado para responder con precisión.',
  key_points: [],
  confidence_note: 'limited_coverage',
}

interface StubOptions {
  body?: unknown
  status?: number
  delayMs?: number
  onCall?: (count: number) => void
}

export async function stubAnswer(page: Page, options: StubOptions = {}) {
  const { body = answerFixture, status = 200, delayMs = 0, onCall } = options
  let calls = 0
  await page.route(ENDPOINT, async (route: Route) => {
    calls += 1
    onCall?.(calls)
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(status === 200 ? body : { detail: 'fallo simulado del servicio' }),
    })
  })
  return () => calls
}
