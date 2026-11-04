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
| `VALIDATION_ERROR` | 422 | Pregunta vacía, de menos de 10 o más de 100 caracteres (puntos de código, sin los espacios de los extremos), o cuerpo mal formado (`details.motivo`: `vacia`, `corta`, `larga`, `formato`). Se valida **antes** de llamar a cualquier servicio. La interfaz aplica la misma regla y no envía una pregunta fuera de rango. El máximo de 100 es una decisión del usuario del 2026-11-01; el mínimo de 10 es la configuración heredada, sin una historia de usuario que lo fije (ver `docs/verificacion/CONSULTA_VALIDACION.md`). |
| `RETRIEVAL_ERROR` | 502 | Falló la recuperación (ForUsGuide `timeout`, `rate_limit`, `server_error`, `client_error`; o embeddings de la pregunta en modo local). |
| `VECTOR_DB_UNAVAILABLE` | 503 | Base vectorial no disponible (ForUsGuide `circuit_open`, `transport`, `503 RAG Engine not initialized`; o índice local). |
| `AI_PROVIDER_ERROR` | 502 | Falló el proveedor que redacta (excepción `unknown` de ForUsGuide, respuesta fija "Unable to generate…", modelo local sin texto). |
| `TIMEOUT` | 504 | Se superó `KD_CONSULTA_TIMEOUT_MS` (30 a 120 s; por defecto 90 s). No se presenta ninguna respuesta parcial. |
| `UPSTREAM_UNREACHABLE` | 503 | No se pudo conectar con ForUsGuide. |
| `UPSTREAM_AUTH_ERROR` | 502 | ForUsGuide rechazó la credencial del servidor (401 o 403). No es reintentable. |
| `UPSTREAM_ERROR` | 502 | Otro error de ForUsGuide o una respuesta con formato inesperado. Si ForUsGuide limita las solicitudes (429), lleva `details.upstream_status: 429` y `details.retry_after_s`. |
| `UPSTREAM_BLOCKED` | 502 | La plataforma que publica ForUsGuide respondió con una página de verificación (`cf-mitigated: challenge`, con cualquier estado). No es reintentable: hace falta que intervenga quien opera esa plataforma, con el ID de soporte. |
| `INTEGRATION_NOT_CONFIGURED` | 503 | El servidor arrancó sin `KD_MODO` o sin la integración necesaria. Nunca inventa una respuesta. |
| `CONTENT_UNAVAILABLE` | 409 | La evidencia incluye una versión no servible (procesando, bloqueada, reemplazada o retirada). Se comprueba después del último `await`. |
| `UNSUPPORTED_FORMAT` | 415 | El archivo no es un artículo JSON kb_article_v2, PDF con texto, DOCX o TXT admitido, o su contenido corresponde a un formato no aprobado. |
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

`POST /api/v1/knowledge-question` es un alias de esta ruta: mismo acceso, validación,
límites y contrato de Knowledge Desk (no el cuerpo de respuesta de ForUsGuide). En modo
`directo`, `engine` vale `directo` y la recuperación y la redacción ocurren en Knowledge
Desk contra el índice Pinecone compartido (solo lectura) y el proveedor configurado.

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
                    "paths": ["details.business_rules[0]"], "operational": false, "content": "…" }],
    "download": {
      "kind": "original", "label": "Descargar original",
      "url": "/api/documentos/DOC-0006/archivo?version=1.0&descargar=1",
      "file_name": "Politica_Viaticos_v3.2.json"
    }
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

- **Descarga de fuentes.** `sources[].download` enlaza el original exacto de la
  versión citada de un documento cargado, con su nombre y formato. Si la fuente es
  un artículo del corpus base sin original disponible, el modo directo ofrece
  `kind: "texto_indexado"`, con la etiqueta "Descargar texto de la fuente": un TXT
  que identifica el artículo y sus fragmentos. No se presenta como el original.
  Si el modo no permite descargar la fuente, `download` es `null`.
- **Fuentes.** Solo artículos con fragmentos usados en el contexto y una afinidad igual o
  superior a `KD_COBERTURA_MIN` (0,20). Los recuperados y descartados no aparecen. El
  mismo texto de un artículo cuenta una sola vez: el chunker repite las reglas de
  elegibilidad en dos fragmentos.
- **Cobertura `kd-cobertura-v1`.** Es una regla reproducible y **no** es una
  probabilidad de acierto. La política calcula un nivel a partir de la media de las 5
  mejores afinidades, de los fragmentos relevantes y de los vacíos declarados
  (`metadata.coverage_gaps`, sin blancos ni repetidos). Si el motor declara su nivel
  (ForUsGuide `confidence_note`), ese nivel es un techo: se usa el menor entre el del
  motor y el de la política, de modo que la evidencia y los vacíos pueden bajarlo pero
  nunca subirlo. Si no hay nivel del motor, se usa el de la política (ver
  `knowledge-desk-server/src/consulta/coverage.ts`). Solo `alta` y `parcial` son
  suficientes. En los modos directo y local, los vacíos los declara el modelo según
  `PROMPT_SISTEMA`: evalúa cada objetivo pedido por separado y no cuenta como vacío
  un detalle, un tema secundario ni un dato personal que la pregunta no necesita.
  Un `baja` con vacíos declarados lo dice en `explanation` (ver
  `docs/verificacion/COBERTURA_DIRECTO_2026-11-04.md`).
- **Con cobertura insuficiente** no se presenta texto generado: `answer` es null y
  `key_points` y `sources` vienen vacíos.
- **Modo local.** Una cita a una sección inexistente, una afirmación sin cita o un punto
  clave sin fuente válida degradan la respuesta a `insufficient`.
- **`corpus_revision`.** Es la revisión que se comprobó después del último `await`. La
  interfaz la usa para no reutilizar respuestas de un corpus anterior: si llega una
  revisión menor que la conocida, repite la consulta (como máximo 2 veces) y, si
  persiste, informa `CORPUS_CHANGED` sin mostrar la respuesta.

## 2. Documentos: artículos JSON, PDF, DOCX y TXT (HU07–HU09)

Formatos admitidos: artículos JSON kb_article_v2, PDF con texto (sin OCR), DOCX y TXT
en UTF-8. La extensión y la firma del contenido deben coincidir; una imagen (PNG,
JPEG, GIF…) u otro formato responde `415 UNSUPPORTED_FORMAT` y un archivo dañado,
protegido o sin texto útil `422 INVALID_DOCUMENT`, en ambos casos sin registrar,
guardar ni indexar nada. De un PDF, DOCX o TXT el servidor extrae el texto, lo
segmenta en bloques y lo clasifica (`kd-clasificacion-v1`); el detalle del documento
incluye `version.texto` y `GET /api/documentos/:id/texto` devuelve el texto extraído.

Los artículos JSON siguen el formato de los artículos de ForUsGuide:

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
| `GET /api/documentos/:id/archivo?version=x[&descargar=1]` | Bytes exactos del original JSON, PDF, DOCX o TXT de esa versión, con su tipo MIME y `X-Content-SHA256`. `descargar=1` entrega un adjunto con el nombre del archivo. |
| `GET /api/operaciones/:id` | Registro técnico: pasos, operador, fechas, resultado y contadores. |
| `GET /api/fuentes/:articleId` | Si el artículo es de Knowledge Desk, redirige a su documento. Si es de ForUsGuide, devuelve **sus fragmentos indexados** (`origen: "fragmentos_indexados"`), porque ForUsGuide no expone el JSON original. |
| `GET /api/fuentes/:articleId/texto` | Exporta los fragmentos de un artículo del corpus base como TXT en UTF-8, con nombre seguro y SHA-256. La primera línea declara que es texto indexado, no el archivo original. No admite IDs de documentos de Knowledge Desk ni mezcla fragmentos de otros artículos. |

## 3. ForUsGuide como servicio externo (modo `forusguide`)

El servidor de Knowledge Desk llama a ForUsGuide. El navegador no.

```http
POST {FORUSGUIDE_API_URL}/api/v1/knowledge-question
Content-Type: application/json
X-API-Key: {FORUSGUIDE_API_KEY}        ← solo en el servidor; nunca VITE_*, nunca en el navegador
X-Correlation-ID: req-7f3a9c2e

{ "question": "…" }
```

- **Producción actual** (verificada el 2026-11-03):
  `FORUSGUIDE_API_URL=https://kb-rag-system-900340137010.us-central1.run.app`
  (Cloud Run).
  - Su `/openapi.json` declara `knowledge-question` con `ApiKeyAuth` (cabecera
    `X-API-Key`) y aclara que no se requiere identidad de Google. Las guías antiguas
    de ForUsGuide que piden un identity token están desactualizadas.
  - `https://forusguide.onrender.com` es una versión antigua y no debe usarse.
- Nunca se envía `ticket_id`, que pertenece al flujo de tickets de ForUsGuide.
- La copia de trabajo de ForUsGuide (2026-10-21) exige `X-API-Key`
  (`kb-rag-system/api/main.py`, `verify_api_key`). La clave la emite quien opera ese
  backend (`API_CLIENT_KEYS`).
- Los errores HTTP de ForUsGuide (`{error, message, request_id}`) se traducen así:
  401 o 403 → `UPSTREAM_AUTH_ERROR`; 422 → `VALIDATION_ERROR`;
  503 → `VECTOR_DB_UNAVAILABLE`; los demás → `UPSTREAM_ERROR`. Su `message` no se
  reenvía.
- Un 429 es una limitación temporal, no una caída. El servidor respeta el plazo
  completo de `Retry-After`, por largo que sea:
  - acepta segundos o una fecha HTTP (IMF-fixdate), con un mínimo de 1 s;
  - si la cabecera falta, no es válida o no se puede representar, aplica 5 s;
  - si la espera es de 10 s o menos, **una sola** consulta reintenta, una vez, al
    terminar la espera y dentro del tiempo máximo de la consulta;
  - las demás consultas que reciben 429 mientras tanto no reintentan;
  - si la espera es más larga, el reintento vuelve a recibir 429 u otra respuesta
    amplía la espera, responde `UPSTREAM_ERROR` con `details.retry_after_s`;
  - mientras dura la espera, ninguna consulta ni fuente externa llama a ForUsGuide:
    responden enseguida con el tiempo restante.

  Del cuerpo de cada 429 se leen como mucho 2048 bytes durante 300 ms, solo para
  clasificarlo en el registro del servidor, y después se libera. Los demás errores
  no se reintentan.
- Una respuesta con `cf-mitigated: challenge` (verificación de Cloudflare) se
  informa como `UPSTREAM_BLOCKED`, sin reintento ni pausa. El servidor no intenta
  resolverla ni elude la barrera cambiando la ruta, la identidad o la IP. El CF-Ray
  queda en el registro del servidor, nunca en la respuesta.
- Con `FORUSGUIDE_COMPROBAR_SALUD=true` (desactivada por defecto), antes de cada
  consulta se pide **una vez** `GET {FORUSGUIDE_API_URL}/health`, sin la clave:
  - espera el arranque normal del servicio dentro del plazo de la consulta;
  - solo un 200 `application/json` con `status` `healthy` u `ok` da paso al POST;
  - un desafío da `UPSTREAM_BLOCKED`; un 429, la espera habitual;
  - un error, un HTML o un JSON sin ese estado dan `UPSTREAM_UNREACHABLE` con
    `details.etapa: "salud"`;
  - si vence el plazo, `TIMEOUT`.

  No hay sondeos programados ni en inactividad. Como un arranque puede tardar cerca
  de un minuto y la consulta otros 40 s, conviene `KD_CONSULTA_TIMEOUT_MS=120000`.
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
