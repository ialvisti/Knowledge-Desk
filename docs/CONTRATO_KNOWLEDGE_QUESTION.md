# Contrato de `POST /api/v1/knowledge-question`

Este documento describe el endpoint tal como está en el código de ForUsGuide, no como
lo describen las propuestas comerciales. Las rutas y líneas se refieren a la copia
de trabajo de `C:\Users\ialvi\ForUsWorkspace\ForUsGuide` el 2026-10-21. Esa copia
incluye cambios locales sin commitear, así que las líneas pueden moverse.

El backend **no forma parte de este proyecto**. Knowledge Desk lo consume como servicio
externo (ver [README](../README.md#qué-sigue-dependiendo-de-forusguide)).

## Dónde vive

| Pieza | Ubicación en ForUsGuide |
| --- | --- |
| Ruta y manejo de errores | `kb-rag-system/api/main.py:1321` (`knowledge_question_endpoint`) |
| Autenticación | `kb-rag-system/api/main.py:749` (`verify_api_key`) → `kb-rag-system/api/auth.py:87` (`authenticate_principal`) |
| Modelos | `kb-rag-system/api/models.py:579` (request), `:612` (response), `:282` (`SourceArticle`), `:302` (`UsedChunk`) |
| Motor | `kb-rag-system/data_pipeline/rag_engine.py:1631` (`ask_knowledge_question`) |
| Cobertura | `kb-rag-system/data_pipeline/rag_engine.py:6144` (`_calculate_knowledge_confidence`) |
| Prompt | `kb-rag-system/data_pipeline/prompts.py:774` (`SYSTEM_PROMPT_KNOWLEDGE_QUESTION`) |
| Cliente en la UI | `knowledge-desk-ui/src/api/knowledgeQuestion.ts` |

## Arquitectura real

FastAPI + Pinecone (índice vectorial) + un modelo de lenguaje. La ruta por defecto
del modelo es OpenAI (`LLM_ROUTE_KNOWLEDGE` y `LLM_ROUTE_DECOMPOSE` = `gpt-5.5` en
`api/config.py:102-106`); Gemini o Vertex son opcionales y quedan desactivados con
`LLM_OPENAI_ONLY=true`. En ForUsGuide el despliegue está en GCP (Cloud Run). La
propuesta comercial menciona además pgvector y Azure; nada de eso aparece en este código.

El índice contiene la base de conocimiento de *Participant Advisory* de ForUsAll:
artículos sobre planes 401(k), mayormente en inglés. El prompt del sistema está
escrito para ese dominio ("401(k) and retirement plan assistant for the ForUsAll
participant advisory team").

## Autenticación: depende de qué versión del backend se use

| Versión del backend | Consulta sin `ticket_id` | Con `ticket_id` |
| --- | --- | --- |
| Commit `94aa4bb` (HEAD, 2026-09-02) | **Pública**, sin cabecera | Exige `X-API-Key` |
| Copia de trabajo con cambios locales sin commitear (`api/main.py` modificado el 2026-10-19) | **Exige `X-API-Key`** | Exige `X-API-Key` |

La UI se escribió el 2026-09-10 contra la versión pública y **no envía `X-API-Key`**.
Contra la copia de trabajo actual, toda consulta acaba en 401. La prueba que fija el
comportamiento nuevo es `kb-rag-system/tests/test_public_api_key.py`, que tampoco está
commiteada.

Cómo se valida la clave: `X-API-Key` se compara en tiempo constante contra
`API_CLIENT_KEYS` (mapa principal → clave) y, como alternativa heredada, contra
`API_KEY` (principal `default`). No se pide token de Google ni cuenta de usuario.

## Request

```http
POST /api/v1/knowledge-question
Content-Type: application/json
X-API-Key: <solo con la versión que la exige>

{ "question": "¿Qué es una distribución mínima requerida (RMD) y cuándo empieza?" }
```

| Campo | Tipo | Regla en el backend | Qué hace la UI |
| --- | --- | --- | --- |
| `question` | string | 10 a 2000 caracteres; se recorta y no puede quedar vacía | Recorta, cuenta puntos de código y bloquea antes de enviar |
| `ticket_id` | string opcional | DevRev DON o display id; activa el registro durable de evaluación de tickets | **No lo envía y no debe hacerlo**: es del flujo de tickets |

Cabeceras opcionales del backend: `X-Correlation-ID` (se devuelve si cumple
`[A-Za-z0-9._:-]{1,128}`) e `Idempotency-Key` (solo tiene efecto con `ticket_id`).
Toda respuesta trae `X-Request-ID`.

## Response 200

```jsonc
{
  "answer": "texto con markdown ligero",
  "key_points": ["..."],
  "source_articles": [
    { "article_id": "...", "article_title": "...", "chunk_types_used": "faqs, steps",
      "relevance": "...", "used_info": true, "max_score": 0.60 }
  ],
  "used_chunks": [
    { "chunk_id": "...", "score": 0.60, "chunk_type": "faqs", "chunk_tier": "low",
      "article_id": "...", "article_title": "...", "content_preview": "...", "content": "..." }
  ],
  "confidence_note": "well_covered | partially_covered | limited_coverage",
  "metadata": { /* ver abajo */ }
}
```

Claves de `metadata` en una respuesta normal: `chunks_used`, `context_tokens`,
`response_tokens`, `prompt_tokens`, `completion_tokens`, `total_tokens`, `model`,
`provider`, `sub_queries`, `unique_articles`, `relevant_articles`, `coverage_gaps`,
`account_recovery_policy`, `per_query_scores`. La UI solo usa `chunks_used`,
`unique_articles`, `model`, `sub_queries` y `error`.

### Respuestas 200 que no son respuestas

El motor atrapa sus propios fallos y devuelve 200. Hay cuatro casos:

| Caso | `answer` (fijo, en inglés) | Marca | La UI hoy |
| --- | --- | --- | --- |
| Excepción en el motor | `An internal error occurred while processing your question.` | `metadata.error = "knowledge_question_failed"`, `retrieval_failure_kind`, `retrieval_retryable` | Lo trata como fallo y ofrece reintentar ✅ |
| Sin fragmentos recuperados | `I couldn't find relevant information in the knowledge base to answer this question.` | `confidence_note = limited_coverage`, `chunks_used = 0`, sin `error` | Lo pinta como respuesta con "Cobertura limitada" |
| El modelo devuelve contenido vacío | `Unable to generate a response. Please try again or contact Support.` | Ninguna; `model = null` | Lo pinta como respuesta ⚠️ |
| El modelo devuelve JSON inválido | `Unable to generate a structured answer.` | Ninguna | Lo pinta como respuesta ⚠️ |

`retrieval_failure_kind` toma uno de estos valores: `timeout`, `transport`,
`rate_limit`, `server_error`, `circuit_open`, `client_error` o `unknown`.

## Errores HTTP

Las `HTTPException` del backend salen con la forma
`{"error": "http_error", "message": <detalle>, "request_id": "..."}`. La clave `detail`
solo aparece si el detalle es un objeto. La UI lee únicamente `detail`, así que para
401, 403, 404 y 500 pierde `message` y muestra "La API respondió con un error N". El 503
tiene mensaje propio en el cliente, que no depende del cuerpo.

| Estado | Cuándo | Cuerpo real | Mensaje en la UI |
| --- | --- | --- | --- |
| 401 | Falta `X-API-Key` (copia de trabajo) | `message: "API key missing. Include 'X-API-Key' header."` | "La API respondió con un error 401." |
| 403 | Clave inválida | `message: "Invalid API key"` | "La API respondió con un error 403." |
| 422 | Validación de Pydantic | `{"detail": [{"msg": "...", ...}]}` (FastAPI, mensajes en inglés) | Concatena los `msg` |
| 500 | Excepción en el handler | `message: "An error occurred while processing the knowledge question."` | "La API respondió con un error 500." |
| 503 | El motor no se inicializó al arrancar (`app.state.rag_engine` vacío) | `message: "RAG Engine not initialized"` | "El servicio de conocimiento no está disponible ahora mismo." |
| 404 | El proceso corre con `APP_ROLE` distinto de `producer` | `{"error": "http_error", "message": "Not Found"}` | "La API respondió con un error 404." |
| 409 | Solo con `ticket_id` e `Idempotency-Key` repetida | — | No aplica |

Errores de red y tiempo agotado: la UI aborta a los `VITE_API_TIMEOUT_MS` (120 000 ms
por defecto) y el proxy de Vite corta a los 180 000 ms. El backend no tiene un límite
propio documentado para esta ruta; no se verificó.

## Cobertura (`confidence_note`)

La calcula el motor con dos señales. **No es una probabilidad de que la respuesta sea
correcta.**

1. Señal principal: `coverage_gaps`, temas que el modelo declara ausentes del contexto.
   - 3 o más → `limited_coverage`
   - 2 → `partially_covered`
   - 1 → `partially_covered` si además hay buena recuperación; si no, `limited_coverage`
2. Sin huecos declarados, decide la recuperación: media de los 5 mejores *scores*
   (`avg`) y número de tipos de alto valor presentes (`business_rules`, `eligibility`,
   `steps`, `faqs`, `guardrails`).
   - `avg ≥ 0.35` y ≥ 3 tipos → `well_covered`
   - `avg ≥ 0.22` y ≥ 2 tipos → `partially_covered`
   - en otro caso → `limited_coverage`

Un artículo de `source_articles` tiene `used_info = true` si su mejor fragmento alcanza
o supera `KQ_SOURCE_MIN_SCORE = 0.20` (`score >= 0.20`).

Parámetros de recuperación (`rag_engine.py:1536-1543`): hasta 3 subconsultas más la
pregunta original, `top_k = 15` por consulta, presupuesto de contexto de 4000 tokens y
un máximo de 6 fragmentos por artículo.

## Lo que la UI deja fuera

`src/lib/answerView.ts` oculta los fragmentos operativos (`critical_flags`,
`decision_guide`, `guardrails`, `response_frames` y `required_data*`). Por eso el
número de fragmentos de una ficha de fuente puede ser menor que `chunks_used`. Ojo:
`guardrails` cuenta para la cobertura aunque no se muestre.

## Efectos y costes de cada consulta

- Sin `ticket_id` no se escribe nada en el registro de tickets. Lo comprueba
  `tests/test_direct_ticket_evaluation.py::test_general_knowledge_call_without_ticket_remains_outside_ticket_ledger`.
- Si el backend tiene `ENABLE_EXECUTION_LOGGING=true`, guarda la pregunta y la
  respuesta en su registro de ejecuciones (GCS).
- Cada consulta pasa normalmente por dos llamadas al modelo (descomposición y
  síntesis) y hasta 4 búsquedas en Pinecone (el backend tiene una caché de consultas
  que no se analizó). Tiene coste real: no se debe usar en pruebas automáticas por
  defecto.

## Dependencias de configuración del backend

Viven en `kb-rag-system/.env` de ForUsGuide. No se copian aquí y nunca deben
copiarse: `PINECONE_API_KEY`, `OPENAI_API_KEY` (o `GEMINI_API_KEY` /
`USE_VERTEX_AI` + `GCP_PROJECT`), `API_KEY` / `API_CLIENT_KEYS`, `ENVIRONMENT`,
`ALLOWED_ORIGINS` (CORS; en `production` se descarta `*`) y `APP_ROLE=producer`.

`GET /health` es público. Responde `status: healthy | degraded`, `pinecone_connected`,
`openai_configured` y `total_vectors`. Si Pinecone no se inicializó, responde 503.

## Pruebas que fijan el contrato

En la UI (este proyecto), con el endpoint simulado: `knowledge-desk-ui/tests/app.spec.ts`
y `tests/fixtures.ts`. Las fixtures son una copia recortada de una respuesta real,
pero sus errores usan `{detail: "..."}`, una forma que el backend real solo emite en 422.

En el backend (ForUsGuide; no se ejecutaron aquí): `tests/test_public_api_key.py`,
`tests/test_direct_ticket_evaluation.py`, `tests/test_rag_engine.py::test_knowledge_question_preserves_closed_retrieval_taxonomy`
y `tests/test_api.py`.
