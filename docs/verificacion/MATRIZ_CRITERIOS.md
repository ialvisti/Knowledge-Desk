# Matriz de trazabilidad: 51 criterios de aceptación (HU01–HU10)

Fuente de los criterios: `docs/negocio/RQ01v1_Historia_de_Usuario_Knowledge_Desk_16092026_V1.pdf`
(original, sin modificar). Decisión de producto vigente: el corpus está formado
**solo por artículos de conocimiento JSON canónicos** (`metadata` + `details`,
kb_article_v2). PDF, DOCX y TXT no forman parte del producto; los PDF de `IMAGENES/`
son solo referencia gráfica. Donde un criterio habla de "documento", "formato
aprobado" o "extraer texto", se aplica a ese JSON.

## Cómo leer esta matriz

El estado se da **por modo**, porque las garantías no son iguales en los dos:

- **Local** (`KD_MODO=local`): Knowledge Desk hace todo el flujo. Recupera de su índice,
  divide la pregunta, deduplica, arma el contexto solo con versiones servibles y valida
  las citas del modelo (proveedor OpenAI-compatible).
- **ForUsGuide** (`KD_MODO=forusguide`): Knowledge Desk envía solo la pregunta a
  `POST /api/v1/knowledge-question`. Recuperación, descomposición, deduplicación,
  contexto y redacción ocurren **dentro de ForUsGuide**. Knowledge Desk actúa después:
  traduce errores, aplica la política de cobertura, deduplica la evidencia que muestra
  y **bloquea** (409 `CONTENT_UNAVAILABLE`) la respuesta si en el contexto entró una
  versión no servible. No puede filtrar antes de que ForUsGuide arme el contexto ni
  obtener el JSON original de un artículo de ForUsGuide. Para eso, ForUsGuide
  necesita una capacidad adicional (ver `NEXT_STEPS.md`).

Valores de estado:

- **Cumple**: implementado y probado en local con servicios simulados.
- **Cumple · aprobación pendiente**: implementado y probado. La regla o el valor es una
  propuesta que negocio debe aprobar.
- **Condicionado**: depende de una capacidad o de una verificación del servicio
  externo. La celda dice cuál.

Los estados de esta matriz se apoyan en la suite de pruebas versionada (la que ejecuta
la CI), con servicios simulados: ninguna de esas pruebas llama a ForUsGuide, Pinecone
ni a un modelo reales.

Aparte de esa suite, el 2026-10-22 se hizo un smoke **operacional real** con
Playwright en modo `local` (vista previa en Render, OpenAI, artículo sintético). Está en el
[registro del despliegue](DEPLOY_RENDER.md). No cambia ningún estado de la matriz y no
toca el modo `forusguide`.

Evidencia:

- `S:` pruebas del servidor (`knowledge-desk-server/test/*.test.ts`).
- `UI:` pruebas de interfaz con el servidor sustituido en el navegador.
- `E2E:` servidor real con ForUsGuide y Pinecone **simulados** (`tests/e2e/flujo.spec.ts`).
- `C:` capturas de `docs/verificacion/`.

## HU01 · Realizar una consulta

| # | Criterio | Implementación y evidencia | Local | ForUsGuide |
| --- | --- | --- | --- | --- |
| 1 | Campo obligatorio: vacío o solo espacios no se envía y se pide escribir | `SearchForm.tsx`, `BarraConsulta`. UI "vacío o solo espacios no envía nada…", "validación: la pregunta corta…" | Cumple | Cumple |
| 2 | Buscar envía una única solicitud y muestra el procesamiento | `useConsulta.ts`, `state/consultas.ts`. UI "Buscar envía UNA solicitud…", "U1: si el corpus cambia…" | Cumple | Cumple |
| 3 | Respuesta correcta presentada sin recargar | `Resultados.tsx` (SPA). UI "Buscar envía UNA solicitud… sin recargar" | Cumple | Cumple |
| 4 | Error técnico o timeout: se informa y no se presenta respuesta (timeout con rango propuesto) | `TIMEOUT` 504 con `KD_CONSULTA_TIMEOUT_MS` acotado a 30–120 s (90 s por defecto). S "el tiempo agotado se informa como TIMEOUT…"; UI "un error técnico o el tiempo agotado…"; C `09` | Cumple · aprobación pendiente (rango) | Cumple · aprobación pendiente (rango) |
| 5 | Cada pregunta es independiente, sin historial | Solo viaja `{question}`; la caché es de navegación. S "envía solo la pregunta…"; UI "cada búsqueda nueva es independiente…" | Cumple | Cumple |
| 6 | Buscar dispara el mismo flujo que un ejemplo | Ambos navegan a `/resultados?q=`. UI "el ejemplo ejecuta el mismo flujo…" | Cumple | Cumple |

## HU02 · Recuperar información relevante

| # | Criterio | Implementación y evidencia | Local | ForUsGuide |
| --- | --- | --- | --- | --- |
| 7 | La búsqueda prioriza la similitud semántica | Local: embeddings del proveedor y coseno (`index/local.ts`). S "indexa con embeddings del proveedor y recupera por similitud de vectores…" | Cumple | Condicionado: la búsqueda la hace ForUsGuide en Pinecone con embeddings integrados; no se verificó contra el índice real |
| 8 | Divide preguntas de varios temas en subpreguntas | Local: `consulta/decompose.ts`; las subconsultas se vectorizan juntas. S "separa temas distintos…", "divide una pregunta de varios temas…" | Cumple | Condicionado: la descomposición es de ForUsGuide (un modelo); Knowledge Desk solo muestra sus `sub_queries`. No se verificó en vivo |
| 9 | Unifica y elimina duplicados **antes** de construir el contexto | Local: `consulta/local.ts` deduplica por ID y por texto idéntico del mismo artículo antes del contexto. S "divide…, unifica y deduplica antes de construir el contexto" | Cumple | Condicionado: el contexto lo arma ForUsGuide y su deduplicación no se verificó. Knowledge Desk deduplica **después**, solo la evidencia que muestra en fuentes y cobertura (S "el mismo texto de un artículo en dos fragmentos… cuenta una vez") |
| 10 | El contexto contiene solo fragmentos del corpus disponible y sus metadatos de origen | Local: `buscarVectores(..., servible)` excluye las versiones no servibles antes del contexto, que se arma como `[n] Fuente: título (rutas JSON)`. S "una respuesta citada por completo…", "si el documento se retira mientras se arman las fuentes…" | Cumple | Condicionado: ForUsGuide arma el contexto con todo el namespace compartido. Knowledge Desk no puede excluir antes una versión en proceso, bloqueada o retirada. La detecta después y bloquea la respuesta (409 `CONTENT_UNAVAILABLE`), y limpia los residuos. Un filtro previo exige que ForUsGuide acepte un filtro de metadatos o una lista de exclusión |
| 11 | Sin evidencia suficiente, el flujo va al aviso de HU05 y no a una respuesta no sustentada | `service.ts`: `outcome: insufficient` sin texto generado; local no llama al modelo sin evidencia. S "sin evidencia relevante no llama al modelo…", "con cobertura insuficiente no presenta…" | Cumple | Cumple (ForUsGuide puede redactar texto, pero Knowledge Desk no lo presenta) |

## HU03 · Recibir una respuesta sustentada

| # | Criterio | Implementación y evidencia | Local | ForUsGuide |
| --- | --- | --- | --- | --- |
| 12 | La respuesta sale del contexto y no incorpora afirmaciones sin fuente | Local: toda afirmación y punto clave debe citar una sección existente o la respuesta se degrada. S "una cita a una sección inexistente invalida…", "una afirmación sin cita…" | Cumple | Condicionado: depende del prompt de ForUsGuide; Knowledge Desk no recibe citas por afirmación para validarlas |
| 13 | Separa la respuesta principal de los puntos relevantes | `Resultados.tsx`. UI "separa respuesta y puntos clave…"; C `02` | Cumple | Cumple |
| 14 | Con evidencia contradictoria, no la oculta y presenta las fuentes | Campo `contradictions` y bloque "Evidencia contradictoria". S "las contradicciones se entregan…"; UI "la evidencia contradictoria se muestra…" | Cumple | Condicionado: ForUsGuide no devuelve contradicciones, así que el bloque no aparece |
| 15 | Si el proveedor falla, se informa y no se reutiliza una respuesta anterior | `AI_PROVIDER_ERROR`; el reintento es otra entrada sin caché. S "diferencia validación, recuperación, base vectorial y proveedor…"; UI "proveedor: tarjeta propia…"; C `08` | Cumple | Cumple |
| 16 | Distingue visualmente una respuesta sustentada del aviso de insuficiencia | Panel de respuesta frente a la tarjeta "Documentación insuficiente". UI "la insuficiencia no presenta texto generado…"; C `02` y `03` | Cumple | Cumple |

## HU04 · Consultar las fuentes de la respuesta

| # | Criterio | Implementación y evidencia | Local | ForUsGuide |
| --- | --- | --- | --- | --- |
| 17 | Cada fuente corresponde a un fragmento usado en el contexto | `construirFuentes` agrupa la evidencia usada (contexto local, o `used_chunks` de ForUsGuide). S "las fuentes son solo artículos con fragmentos usados sobre el umbral…" | Cumple | Cumple (según los `used_chunks` que declara ForUsGuide) |
| 18 | No muestra recuperados descartados como sustento | Umbral `KD_COBERTURA_MIN`; `found_documents` solo con insuficiencia. S "…los descartados no aparecen"; UI "la insuficiencia… ver lo encontrado" | Cumple | Cumple |
| 19 | Sin evidencia, sin referencias inventadas, y aplica HU05 | `sources: []` con `insufficient`. UI "sin evidencia no hay documentos que ver…"; C `04` | Cumple | Cumple |
| 20 | Metadatos visibles consistentes con los almacenados al indexar | Título = `metadata.title`; versión y rutas JSON salen del registro de la versión usada. S "valida, fragmenta…; la consulta lo cita por ruta JSON"; E2E "HU02–HU04…" | Cumple | Cumple para artículos de Knowledge Desk; para los de ForUsGuide se muestran los metadatos de su índice |
| 21 | Título y flecha clicables, misma acción: abrir el documento completo | Ambos enlaces abren `/documentos/:id?version=x`: el JSON auténtico de **esa** versión, con las rutas resaltadas y el SHA-256 verificado. UI "el título y la flecha…", "desde una fuente: JSON formateado…"; C `18`, `19` | Cumple (todos los artículos son gestionados) | Condicionado: los artículos de Knowledge Desk abren su JSON original. Los del corpus de ForUsGuide abren `/fuentes/:id` con sus **fragmentos indexados** y el aviso de que no es el original (C `20`; UI "una fuente de ForUsGuide dice…"). El JSON original externo exige que ForUsGuide lo exponga |

## HU05 · Conocer la cobertura de la respuesta

| # | Criterio | Implementación y evidencia | Local | ForUsGuide |
| --- | --- | --- | --- | --- |
| 22 | El backend calcula el indicador con una regla reproducible y lo entrega con la respuesta | `kd-cobertura-v1` (`coverage.ts`); respeta `confidence_note` de ForUsGuide. S "cobertura alta, límite, baja y ausencia total…", "respeta el nivel del motor…" | Cumple · aprobación pendiente (fórmula y umbrales) | Cumple · aprobación pendiente (nivel del motor de ForUsGuide + umbral de relevancia) |
| 23 | La interfaz muestra el nivel de forma comprensible | Insignia y explicación; aclara que no es una probabilidad. UI "…cobertura explicada…" | Cumple | Cumple |
| 24 | Por debajo del umbral se informa que la documentación no es suficiente | Tarjeta "Documentación insuficiente". UI "la insuficiencia…"; C `03` | Cumple | Cumple |
| 25 | Una cobertura insuficiente impide presentar afirmaciones generadas | `answer: null`, `key_points: []`, `sources: []`. S "con cobertura insuficiente no presenta la respuesta generada…" | Cumple | Cumple |
| 26 | Pruebas de cobertura alta, límite, baja y ausencia de evidencia | S "cobertura alta, límite, baja y ausencia total de evidencia" | Cumple | Cumple |

## HU06 · Usar preguntas de ejemplo

| # | Criterio | Implementación y evidencia | Local | ForUsGuide |
| --- | --- | --- | --- | --- |
| 27 | Ejemplos relacionados con lo realmente cargado | `examples.ts` contrasta cada ejemplo con el índice y muestra solo los que tienen evidencia. S "los ejemplos solo muestran preguntas con evidencia…" | Cumple | Condicionado: la verificación usa el índice real, que no se consultó. Hay que escribir los ejemplos de `config/ejemplos.json` para el corpus aprobado |
| 28 | Sin datos personales, financieros ni de sistemas externos | `revisarEjemplo`. S "un ejemplo que promete datos personales…" | Cumple | Cumple |
| 29 | El ejemplo ejecuta la consulta directamente, igual que Buscar | UI "el ejemplo ejecuta el mismo flujo…" | Cumple | Cumple |
| 30 | El equipo actualiza los ejemplos sin modificar la lógica | `config/ejemplos.json` (`KD_EJEMPLOS_ARCHIVO`), releído al cambiar el archivo o el corpus. S "el equipo actualiza los ejemplos editando config/ejemplos.json…" | Cumple | Cumple |

## HU07 · Incorporar un artículo JSON al corpus

| # | Criterio | Adaptación a JSON, implementación y evidencia | Local | ForUsGuide |
| --- | --- | --- | --- | --- |
| 31 | Acepta solo formatos aprobados y rechaza el resto con un mensaje claro | Formato aprobado: `.json` kb_article_v2 de hasta 50 MB. El resto → `UNSUPPORTED_FORMAT`, `INVALID_ARTICLE` (con la ruta JSON exacta), `EMPTY_FILE` o `FILE_TOO_LARGE`. S "rechaza otros formatos…", "el archivo: solo .json…"; UI "la carga acepta solo JSON…"; E2E "JSON mal formado…" | Cumple | Cumple |
| 32 | Detecta cuando no hay texto útil, no lo marca como indexado y dice por qué | Al menos 40 letras en las secciones que se indexan. Claves ajenas, banderas o secciones vacías → **Error** con el motivo; nunca se publica. S "un artículo sin contenido indexable…", "J3…"; E2E "…quedan en Error"; C `11` | Cumple | Cumple |
| 33 | Se fragmenta, se clasifica según la regla aprobada y se generan embeddings | Port del KBChunker de ForUsGuide (`forusguide-kbchunker-port-v1`); embeddings del proveedor (local) o integrados de Pinecone (ForUsGuide). S "conserva el orden, los tipos, las categorías y los niveles de chunking.py", "J1…", "J2…", "una regla larga se divide…" | Cumple · aprobación pendiente (regla de clasificación) | Cumple · aprobación pendiente; embeddings de Pinecone no verificados en vivo |
| 34 | Disponible para consultas solo al terminar el procesamiento completo | Activación solo tras ver todos los IDs en el índice y que sea buscable; si no, rollback. S "espera a que el índice muestre todos los registros…", "si el índice nunca confirma…" | Cumple | Cumple (con el índice simulado; ver #36) |
| 35 | Filtrar la tabla escribiendo el nombre en Buscar | Filtro por nombre de archivo, título y `article_id`, sin distinguir acentos ni mayúsculas. UI "la barra Buscar filtra la tabla por nombre…" | Cumple | Cumple |
| 36 | Solo los Indexado son fuente; Procesando y Error no aparecen | Local: excluidos antes del contexto. ForUsGuide: los vectores de una versión en proceso ya están en el namespace compartido. Si entran en el contexto, la respuesta se **bloquea** (409) en vez de presentarse. S "el fallo parcial bloquea…", "cada consulta usa solo la versión vigente…"; C `10` | Cumple | Condicionado: nunca aparecen como fuente, pero una consulta concurrente puede fallar con 409 mientras dura el procesamiento. Ver #10 |

## HU08 · Reemplazar un artículo JSON

| # | Criterio | Adaptación a JSON, implementación y evidencia | Local | ForUsGuide |
| --- | --- | --- | --- | --- |
| 37 | El operador identifica de forma inequívoca el documento que se reemplaza | Título canónico, ID, versión, fecha y fragmentos activos. El servidor exige el **mismo** `metadata.article_id` (`ARTICLE_MISMATCH`). S "el reemplazo debe ser del mismo artículo canónico"; E2E "un archivo de otro artículo…"; C `12` | Cumple | Cumple |
| 38 | La nueva versión pasa por el mismo flujo de HU07 | S "el reemplazo exitoso activa la nueva versión…"; E2E "HU08: reemplazar…" | Cumple | Cumple |
| 39 | Con sustitución total, los fragmentos retirados no aparecen en respuestas nuevas | La versión anterior deja de ser servible al activar la nueva y sus vectores se retiran (con limpieza diferida si falla). S "…retira la anterior y no mezcla contenido", "un EACCES al retirar la versión anterior…" | Cumple · aprobación pendiente (política de sustitución total) | Condicionado: mientras la limpieza esté pendiente, una consulta que recupere un vector viejo se bloquea (409) en vez de usarlo. Además, aprobación pendiente |
| 40 | Si falla la reindexación, el estado es consistente y no se mezclan fragmentos incompletos | Se conserva la versión vigente; lo enviado de la nueva se retira. S "si falla la reindexación, conserva la versión vigente…"; C `14` | Cumple | Cumple |
| 41 | Evidencia técnica: documento, fecha y resultado | Registro de operación: pasos, operador, fechas, resultado y SHA-256. S "el reemplazo exitoso activa la nueva versión…" (comprueba documento, inicio, fin, operador y resultado); C `13` | Cumple | Cumple |

## HU09 · Eliminar un artículo

| # | Criterio | Implementación y evidencia | Local | ForUsGuide |
| --- | --- | --- | --- | --- |
| 42 | Solicita confirmación antes de eliminar | Casilla obligatoria; el servidor exige `{confirmado: true}`. S "exige confirmación explícita"; C `15` | Cumple | Cumple |
| 43 | Retira todos los fragmentos y embeddings del documento | Borrado por prefijo e IDs conocidos, con conteos **medidos**. S "el fallo parcial… el reintento completa la eliminación"; C `17` | Cumple | Cumple (con el índice simulado; borrado en Pinecone real no verificado) |
| 44 | Las consultas posteriores no lo muestran ni usan su contenido | Bloqueado desde la reserva y retirado al terminar. S "cada consulta usa solo la versión vigente y nunca resucita un documento retirado" | Cumple | Condicionado: mientras la eliminación esté incompleta, una consulta que recupere sus vectores se bloquea (409). Tras completarla, no quedan vectores |
| 45 | Si es parcial o falla, informa el error y no la reporta como exitosa | `fallido_parcial`, documento bloqueado y reintento. Lo desconocido no se guarda como 0. S "D1: totales ilegibles no se guardan como 0…", "tras un reemplazo, el total de embeddings…"; E2E "HU09…"; C `16` | Cumple | Cumple |
| 46 | Conserva la evidencia técnica de la política de auditoría | Operación con pasos, contadores, operador y fechas; el original se archiva en `archivo-retirados/`. S "archivar es idempotente…" | Cumple · aprobación pendiente (política de retención) | Cumple · aprobación pendiente (política de retención) |

## HU10 · Consumir el servicio de consulta

| # | Criterio | Implementación y evidencia | Local | ForUsGuide |
| --- | --- | --- | --- | --- |
| 47 | Valida la pregunta antes de recuperar o generar | `validarPregunta` antes del motor. S "valida la pregunta antes de llamar a ningún servicio"; C `05` | Cumple | Cumple |
| 48 | La respuesta exitosa trae respuesta, puntos, fuentes, cobertura y estado | Contrato `POST /api/consulta` (`docs/CONTRATO_KNOWLEDGE_QUESTION.md`). S "la respuesta sustentada trae…" | Cumple | Cumple (contrato de ForUsGuide verificado solo contra su simulador) |
| 49 | Diferencia validación, recuperación, base vectorial y proveedor sin exponer secretos | `VALIDATION_ERROR`, `RETRIEVAL_ERROR`, `VECTOR_DB_UNAVAILABLE`, `AI_PROVIDER_ERROR`. S "diferencia validación…", "el estado público no expone claves…"; UI "HU10 · errores diferenciados…"; C `05`–`08` | Cumple | Cumple (el mapeo de `retrieval_failure_kind` sigue el código de ForUsGuide; `unknown` se infiere como proveedor) |
| 50 | Pruebas del contrato exitoso y de los errores esperados | S `consulta.test.ts` completo, "un servicio inalcanzable…", "una credencial rechazada…" | Cumple | Cumple |
| 51 | Sin contexto conversacional entre solicitudes | S "envía solo la pregunta…" | Cumple | Cumple |

## Resumen por modo

Recuento calculado sobre las 51 filas de las tablas anteriores:

| Estado | Local | ForUsGuide |
| --- | --- | --- |
| Cumple | 46 | 36 |
| Cumple · aprobación pendiente | 5 (#4, #22, #33, #39, #46) | 4 (#4, #22, #33, #46) |
| Condicionado | 0 | 11 (#7, #8, #9, #10, #12, #14, #21, #27, #36, #39, #44) |

En modo ForUsGuide, además, varias filas que cumplen (#20, #34, #43, #48 y #49) llevan
anotado lo que solo se verificó contra los simuladores. Que el modo ForUsGuide quede
completo exige las capacidades de ForUsGuide y la integración en vivo de
[`NEXT_STEPS.md`](../../NEXT_STEPS.md).

## También verificado (fuera de los criterios)

- **Acceso**: fuera de localhost el arranque exige una de estas opciones (S
  `acceso.test.ts`, `produccion.test.ts`):
  - `KD_ACCESO_BASICO`;
  - un proxy de identidad con secreto;
  - `KD_ACCESO_PUBLICO=true`, el acceso sin inicio de sesión decidido para la vista
    previa. Es incompatible con las otras dos opciones y con `KD_OPERADORES`.
- **Sincronización de la interfaz**: cada caso tiene su regresión en
  `tests/ui/consulta.spec.ts`.
  - U1: respuestas de un corpus anterior, con reintento limitado y error explícito.
  - U2: una petición ya cancelada no se envía.
  - U3: se revalida al volver a la pestaña, al navegar y desde otra pestaña, y se
    comprueba antes de reutilizar una respuesta.
- **Fidelidad visual**: Documentos a 1848 × 692 igual a la referencia (panel a 208 px,
  filas de 70 px, zona de carga hasta 584 px), según `geometria-documentos.json`.
