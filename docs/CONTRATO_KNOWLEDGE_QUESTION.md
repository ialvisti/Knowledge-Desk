# Contratos de Knowledge Desk

Tres contratos, de afuera hacia adentro:

1. **Consulta** (`POST /api/consulta`): lo que consume la interfaz. Es el contrato
   único de HU10.
2. **Artículos de conocimiento JSON** (`/api/documentos…`): administración del corpus
   (HU07 a HU09).
3. **ForUsGuide** (`POST /api/v1/knowledge-question` y `POST /api/v1/chunks`): el
   servicio externo que el servidor de Knowledge Desk llama en modo `forusguide`.
   El navegador nunca lo llama.

Todos los ejemplos usan datos sintéticos. Las rutas de ForUsGuide se refieren a su copia
de trabajo del 2026-10-21, consultada en solo lectura.

## Contrato de error común

Todo error del servidor de Knowledge Desk tiene esta forma, con el mismo `request_id`
en la cabecera `X-Request-ID`:

```json
{
  "status": "error",
  "code": "RETRIEVAL_ERROR",
  "message": "Ocurrió un problema al recuperar la información. Inténtalo de nuevo en unos minutos.",
  "details": { "retryable": true },
  "request_id": "req-c92e51f8"
}
```

- `request_id` tiene la forma `req-` + 8 hexadecimales. El navegador lo propone en
  `X-Request-ID`. Si no es válido, el servidor genera otro.
- `message` está escrito para quien usa la interfaz. Nunca incluye cuerpos de servicios
  externos, claves, hosts ni rutas internas.
- `details` solo lleva datos no sensibles: `retryable`, el motivo de una validación,
  la ruta JSON de un artículo inválido, el estado HTTP de un servicio externo y
  similares.

| Código | HTTP | Cuándo |
| --- | --- | --- |
| `VALIDATION_ERROR` | 422 | Pregunta vacía, de menos de 10 o más de 2000 caracteres, o cuerpo mal formado (`details.motivo`: `vacia`, `corta`, `larga`, `formato`). Se valida **antes** de llamar a cualquier servicio. |
| `RETRIEVAL_ERROR` | 502 | Falló la recuperación (ForUsGuide `timeout`, `rate_limit`, `server_error`, `client_error`; o embeddings de la pregunta en modo local). |
| `VECTOR_DB_UNAVAILABLE` | 503 | Base vectorial no disponible (ForUsGuide `circuit_open`, `transport`, `503 RAG Engine not initialized`; o índice local). |
| `AI_PROVIDER_ERROR` | 502 | Falló el proveedor que redacta (excepción `unknown` de ForUsGuide, respuesta fija "Unable to generate…", modelo local sin texto). |
| `TIMEOUT` | 504 | Se superó `KD_CONSULTA_TIMEOUT_MS` (30 a 120 s; por defecto 90 s). No se presenta ninguna respuesta parcial. |
| `UPSTREAM_UNREACHABLE` | 503 | No se pudo conectar con ForUsGuide. |
| `UPSTREAM_AUTH_ERROR` | 502 | ForUsGuide rechazó la credencial del servidor (401 o 403). No es reintentable. |
| `UPSTREAM_ERROR` | 502 | Otro error de ForUsGuide o una respuesta con formato inesperado. |
| `INTEGRATION_NOT_CONFIGURED` | 503 | El servidor arrancó sin `KD_MODO` o sin la integración necesaria. Nunca inventa una respuesta. |
| `CONTENT_UNAVAILABLE` | 409 | La evidencia incluye una versión no servible (procesando, bloqueada, reemplazada o retirada). Se comprueba después del último `await`. |
| `UNSUPPORTED_FORMAT` | 415 | El archivo no es `.json`. |
| `EMPTY_FILE` | 400 | Archivo vacío o solo espacios. |
| `FILE_TOO_LARGE` | 413 | Supera `KD_MAX_ARTICULO_MB` (por defecto 50 MB). |
| `INVALID_ARTICLE` | 422 | No es UTF-8, no es JSON o no cumple kb_article_v2. `details.ruta` indica la ruta exacta (por ejemplo `details.steps[2].description`). |
| `DUPLICATE_DOCUMENT` | 409 | Ya hay un documento vigente con ese nombre de archivo. |
| `DUPLICATE_ARTICLE` | 409 | Ya existe ese `article_id`, en Knowledge Desk o en el corpus de ForUsGuide. |
| `ARTICLE_MISMATCH` | 409 | El reemplazo trae otro `article_id`. |
| `DOCUMENT_BUSY` | 409 | Ya hay otra operación en curso sobre el documento. |
| `INVALID_STATE` | 409 | El documento no admite esa acción en su estado. |
| `CONFIRMATION_REQUIRED` | 400 | Eliminación sin `{"confirmado": true}`. |
| `INDEX_NOT_CONFIGURED` | 503 | Se intentó indexar sin índice configurado. |
| `FILE_REQUIRED` | 400 | Petición multipart sin archivo. |
| `NOT_FOUND` / `SOURCE_NOT_AVAILABLE` | 404 | Recurso o fuente inexistente. |
| `ACCESS_DENIED` | 401 | Sin credencial de piloto ni identidad de proxy válida. |
| `OPERATOR_REQUIRED` | 403 | El usuario no está en `KD_OPERADORES`. |
| `INTERNAL_ERROR` | 500 | Error no controlado. Sin detalles internos. |

## 1. `POST /api/consulta` (HU01–HU05, HU10)

```http
POST /api/consulta
Content-Type: application/json
X-Request-ID: req-7f3a9c2e

{ "question": "¿Cuál es el procedimiento para reembolso de viáticos internacionales?" }
```

Solo viaja la pregunta. Cualquier otro campo (`ticket_id`, contexto anterior) se
ignora y no se reenvía. El servicio no guarda contexto entre solicitudes.

Respuesta 200 (con el texto recortado):

```jsonc
{
  "status": "ok",
  "request_id": "req-7f3a9c2e",
  "question": "¿Cuál es el procedimiento para reembolso de viáticos internacionales?",
  "outcome": "answered",                 // o "insufficient"
  "answer": "Según la documentación recuperada: …",   // null si outcome = insufficient
  "key_points": ["…"],                   // [] si outcome = insufficient
  "coverage": {
    "level": "alta",                     // alta | parcial | baja | sin_evidencia
    "label": "Cobertura alta",
    "explanation": "Varias fuentes aprobadas tratan directamente tu consulta.",
    "sufficient": true,
    "relevant_fragments": 5, "total_fragments": 6, "documents": 1,
    "policy": "kd-cobertura-v1",
    "basis": "motor"                     // motor (ForUsGuide) o politica (local)
  },
  "sources": [{
    "id": "kd_doc0006_v1_0",             // ID interno de la versión, o article_id de ForUsGuide
    "kind": "document",                  // document (Knowledge Desk) | external_article (ForUsGuide)
    "title": "Política de viáticos internacionales",   // metadata.title del JSON
    "file_name": "Politica_Viaticos_v3.2.json",
    "article_id": "politica_viaticos_internacionales", // metadata.article_id canónico
    "href": "/documentos/DOC-0006?version=1.0",        // abre el JSON de ESA versión
    "document_id": "DOC-0006", "version": "1.0",
    "location": "details.business_rules[0]",           // rutas JSON resumidas
    "affinity": 0.45, "fragment_count": 4,
    "fragments": [{ "id": "kd_doc0006_v1_0_chunk_1", "affinity": 0.45, "type": "eligibility",
                    "paths": ["details.business_rules[0]"], "operational": false, "content": "…" }]
  }],
  "found_documents": [],                 // con insufficient: lo encontrado, sin presentarlo como sustento
  "contradictions": [],                  // [{ description, source_ids }] para revisión humana
  "retrieval": { "fragments_retrieved": 6, "articles_consulted": 1, "model": "…", "sub_queries": ["…"], "generated": true },
  "engine": "forusguide",
  "elapsed_ms": 1840,
  "corpus_revision": 7
}
```

Reglas que el servidor garantiza:

- **Fuentes.** Solo artículos con fragmentos usados en el contexto y una afinidad igual o
  superior a `KD_COBERTURA_MIN` (0,20). Los recuperados y descartados no aparecen. El
  mismo texto de un artículo cuenta una sola vez: el chunker repite las reglas de
  elegibilidad en dos fragmentos.
- **Cobertura `kd-cobertura-v1`.** Es una regla reproducible y **no** es una
  probabilidad de acierto. Si el motor declara su nivel (ForUsGuide `confidence_note`),
  se respeta. Si no, se calcula a partir de la media de las 5 mejores afinidades, de
  los fragmentos relevantes y de los vacíos declarados (ver
  `knowledge-desk-server/src/consulta/coverage.ts`). Solo `alta` y `parcial` son
  suficientes.
- **Con cobertura insuficiente** no se presenta texto generado: `answer` es null y
  `key_points` y `sources` vienen vacíos.
- **Modo local.** Una cita a una sección inexistente, una afirmación sin cita o un punto
  clave sin fuente válida degradan la respuesta a `insufficient`.
- **`corpus_revision`.** Es la revisión que se comprobó después del último `await`. La
  interfaz la usa para no reutilizar respuestas de un corpus anterior: si llega una
  revisión menor que la conocida, repite la consulta (como máximo 2 veces) y, si
  persiste, informa `CORPUS_CHANGED` sin mostrar la respuesta.

## 2. Artículos de conocimiento JSON (HU07–HU09)

Knowledge Desk administra **solo** artículos JSON kb_article_v2, el formato de los
artículos de ForUsGuide:

```jsonc
{
  "metadata": {
    "article_id": "politica_viaticos_internacionales",  // obligatorio, ≤ 200 caracteres
    "title": "Política de viáticos internacionales",    // obligatorio, ≤ 500 caracteres
    "record_keeper": null,                              // obligatorio, puede ser null (= "all")
    "plan_type": null,                                  // obligatorio, puede ser null (= "all")
    "description": "…", "scope": "internal", "tags": [], "subtopics": [], "topic": "…",
    "schema_version": "kb_article_v2"
  },
  "details": {
    "critical_flags": {}, "business_rules": [], "fees": [], "steps": [], "common_issues": [],
    "examples": [], "additional_notes": [], "faq_pairs": [], "definitions": [], "guardrails": {},
    "references": {}, "required_data": {}, "decision_guide": {}, "response_frames": {}
  }
}
```

- **Validación** (`src/documents/articulo.ts`): UTF-8 estricto (se admite BOM), JSON
  válido, raíz con `metadata` y `details`, y tipos de cada sección por ruta. Los
  opcionales ausentes no rechazan el artículo. `summary` (legado) y las claves raíz
  ajenas se conservan en el original con un aviso y no se indexan.
- **Contenido útil**: hacen falta al menos 40 letras en los campos que de verdad se
  indexan. Ni las claves ajenas al esquema, ni las banderas, ni los encabezados cuentan.
  Un artículo sin contenido útil queda en **Error** y nunca se publica.
- **Fragmentación** (`src/documents/chunker.ts`, regla `forusguide-kbchunker-port-v1`):
  es un port del `KBChunker` de ForUsGuide (`kb-rag-system/data_pipeline/chunking.py`).
  Conserva el mismo orden, texto, `chunk_type`, `chunk_category` y nivel, los pasos y
  FAQ de tres en tres y el `content_hash` md5 de 8 caracteres. Cada fragmento añade sus
  rutas JSON (`kd_json_paths`). Un fragmento de más de 4000 caracteres se divide en
  partes sin perder texto. El encabezado repetido se acota a 160 caracteres, de modo
  que categorías o títulos enormes no bloquean la división.
- **Registro en el índice**: `article_id` es el ID **interno** de la versión
  (`kd_doc0006_v1_0`) y aísla versiones sin pisar los IDs de ForUsGuide. El ID canónico
  viaja en `source_article_id`; `record_keeper` y `plan_type` nulos se guardan como
  `"all"`. Los textos libres de los metadatos se acotan por el límite de 40 KB de
  Pinecone.
- **Original intacto**: los bytes cargados se guardan sin modificar. `GET …/archivo`
  los devuelve tal cual, con `X-Content-SHA256`, y el visor los verifica en el
  navegador.

| Método y ruta | Uso |
| --- | --- |
| `GET /api/documentos` | Lista con `nombre`, `titulo`, `articuloId`, `estado` (`indexado`, `procesando`, `error`, `eliminando`, `bloqueado`), `fragmentos`, `fechaCarga` y `revisionCorpus`. |
| `POST /api/documentos` (multipart `archivo`) | Carga (202). Valida, guarda el original y procesa en segundo plano: lectura → fragmentación → embeddings → verificación de IDs y búsqueda → activación. |
| `POST /api/documentos/:id/reemplazo` | Reemplazo por una versión del **mismo** `article_id`. La versión vigente sirve hasta que la nueva queda verificada. Si algo falla, no se publica nada de la nueva. |
| `POST /api/documentos/:id/reintento` | Reprocesa un documento en Error que aún no tiene versión activa. |
| `POST /api/documentos/:id/eliminacion` `{"confirmado": true}` | Retira fragmentos, embeddings y registro. Los contadores son **medidos**: si queda algo, es `fallido_parcial`, el documento queda bloqueado y se puede reintentar. |
| `GET /api/documentos/:id?version=x` | Detalle: identidad del artículo, SHA-256, fragmentos con tipo, nivel, rutas y parte, versiones y operaciones. |
| `GET /api/documentos/:id/archivo?version=x[&descargar=1]` | El JSON original exacto (`application/json; charset=utf-8`). |
| `GET /api/operaciones/:id` | Registro técnico: pasos, operador, fechas, resultado y contadores. |
| `GET /api/fuentes/:articleId` | Si el artículo es de Knowledge Desk, redirige a su documento. Si es de ForUsGuide, devuelve **sus fragmentos indexados** (`origen: "fragmentos_indexados"`), porque ForUsGuide no expone el JSON original. |

## 3. ForUsGuide como servicio externo (modo `forusguide`)

El servidor de Knowledge Desk llama a ForUsGuide. El navegador no.

```http
POST {FORUSGUIDE_API_URL}/api/v1/knowledge-question
Content-Type: application/json
X-API-Key: {FORUSGUIDE_API_KEY}        ← solo en el servidor; nunca VITE_*, nunca en el navegador
X-Correlation-ID: req-7f3a9c2e

{ "question": "…" }
```

- Nunca se envía `ticket_id`, que pertenece al flujo de tickets de ForUsGuide.
- La copia de trabajo de ForUsGuide (2026-10-21) exige `X-API-Key`
  (`kb-rag-system/api/main.py`, `verify_api_key`). La clave la emite quien opera ese
  backend (`API_CLIENT_KEYS`).
- Los errores HTTP de ForUsGuide (`{error, message, request_id}`) se traducen así:
  401 o 403 → `UPSTREAM_AUTH_ERROR`; 422 → `VALIDATION_ERROR`;
  503 → `VECTOR_DB_UNAVAILABLE`; los demás → `UPSTREAM_ERROR`. Su `message` no se
  reenvía.
- Respuestas 200 que **no** son respuestas:

  | ForUsGuide | Knowledge Desk |
  | --- | --- |
  | `metadata.error` con `retrieval_failure_kind` (`timeout`, `rate_limit`, `server_error` o `client_error`) | `RETRIEVAL_ERROR` |
  | `metadata.error` con `circuit_open` o `transport` | `VECTOR_DB_UNAVAILABLE` |
  | `metadata.error` con `unknown` | `AI_PROVIDER_ERROR` (inferido) |
  | `answer` = "Unable to generate a response…" o "Unable to generate a structured answer." | `AI_PROVIDER_ERROR` |
  | `answer` = "I couldn't find relevant information…" | `outcome: insufficient`, `sin_evidencia` |

- `used_chunks` es la evidencia, y `confidence_note` el nivel del motor
  (`well_covered` → alta, `partially_covered` → parcial, `limited_coverage` → baja).
  `metadata.model`, `sub_queries`, `chunks_used` y `unique_articles` alimentan los
  metadatos de procesamiento.
- Los documentos se indexan en el **mismo** índice Pinecone y namespace que lee
  ForUsGuide (`PINECONE_NAMESPACE`, por defecto `kb_articles`), con embeddings
  integrados (`upsertRecords` con el campo `content`). ForUsGuide los recupera como a
  su propio corpus. El servidor excluye en cada respuesta las versiones no servibles y
  limpia los residuos.
- `POST /api/v1/chunks` `{article_id, limit}` se usa para mostrar los fragmentos
  indexados de un artículo externo.

Efectos y costes: cada consulta real a ForUsGuide hace llamadas al modelo y a
Pinecone, y tiene coste. Si ForUsGuide tiene `ENABLE_EXECUTION_LOGGING=true`, guarda la
pregunta y la respuesta. Ninguna prueba automática de este proyecto llama a ForUsGuide
ni a Pinecone reales: usan los simuladores de `knowledge-desk-server/test/support/`.
