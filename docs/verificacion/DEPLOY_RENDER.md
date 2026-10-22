# Vista previa en Render: registro del despliegue

## Servicio

| Dato | Valor |
| --- | --- |
| URL | <https://knowledge-desk-preview.onrender.com> |
| Servicio | `srv-dbd57prncjis73b619sg` |
| Plan | **Free**, región Oregon, **sin disco**, `autoDeploy` desactivado |
| Despliegue actual | `dep-dbd779ifngtc73fron20` (live): `main`, commit `5c1df338dc04168e4d781ff0d9f0234ac4005634`. El `render.yaml` y el panel coinciden |
| Modo actual | `KD_MODO=forusguide` de solo consulta, con acceso público y sin credenciales de Pinecone |
| Despliegue anterior (histórico) | `dep-dbd5qu3l550s73apj9gg`: commit `4a75c397d5161aa265dc56504ce62aa4b6652b7b`, ya en modo `forusguide` con la configuración aplicada en el panel. Sobre él se hizo la prueba en vivo |
| Primer despliegue (histórico) | `dep-dbd57qbncjis73b61bi0`: commit `9337e67d924b3492d245c6423cb01513508b8a2e`, `KD_MODO=local` con OpenAI (chat `gpt-6-luna` con `KD_CHAT_REASONING_EFFORT=none`, embeddings `text-embedding-3-small`) y acceso protegido |
| Datos | `KD_DATA_DIR=/tmp/knowledge-desk`, `KD_DATOS_TEMPORALES=true`, JSON de hasta 10 MB |
| Secretos | Solo en el panel de Render; nunca en el repositorio ni en este registro. Actual: `FORUSGUIDE_API_KEY`, que se transfirió en privado. La clave de OpenAI y las credenciales de piloto de `9337e67` ya no están en el panel |

## Restricciones de esta vista previa

- **Los datos son temporales.**
  - Sin disco, el corpus, el registro y el índice viven en el sistema de archivos
    efímero de la instancia.
  - Render suspende un servicio gratuito tras unos 15 minutos sin tráfico; la primera
    petición al despertarlo tarda más.
  - Al despertar, reiniciar o redesplegar, los artículos cargados **se pierden** y
    hay que volver a cargarlos. El pie de Documentos lo avisa. En el modo actual no
    se cargan artículos y las consultas no se guardan en el servidor: no hay nada que
    perder.
- **Coste.** El cómputo es del plan gratuito, sin plan de pago ni disco.
  - En `9337e67`, cada carga (embeddings) y cada consulta (embeddings y chat) llamaban
    a la API de OpenAI.
  - En el modo actual, cada consulta llama a ForUsGuide y consume la cuota de ese
    servicio.
- **Acceso.** En el despliegue `9337e67` todo exigía las credenciales de piloto (HTTP
  Basic), salvo `/api/salud`. Desde `dep-dbd5qu3l550s73apj9gg` el acceso es directo,
  sin inicio de sesión (ver la sección siguiente).
- **Arranque.** Nada se carga solo al arrancar. En `9337e67` el corpus se subía a mano
  desde Documentos. En el modo actual no se sube nada: el corpus es el de ForUsGuide.

## Decisión posterior: acceso sin inicio de sesión

Después del smoke, el usuario pidió quitar el login de esta vista previa.

- **Configuración.**
  - `render.yaml` fija `KD_ACCESO_PUBLICO=true` y ya no declara `KD_ACCESO_BASICO` ni
    `KD_OPERADORES`.
  - `KD_ACCESO_BASICO` y `KD_OPERADORES` ya no están en el panel. El servidor rechaza
    combinar el acceso público con credenciales, proxy de identidad u operadores,
    para no mezclar identidades.
- **Qué cambia.**
  - Cualquiera con la URL entra directamente, consulta y carga, ve, reemplaza o elimina
    artículos JSON.
  - Las operaciones se registran como "Acceso público".
  - En el modo `local` de entonces, cada uso consumía la cuota de OpenAI.
- **Qué no cambia.** Plan free sin disco, datos temporales y límite de 10 MB. El modo
  cambió después a ForUsGuide (siguiente sección): con él ya no se cargan artículos.
- **Verificado en local** (con servicios simulados y el build de producción en un
  navegador sin credenciales):
  - `/` y `/documentos` responden 200 sin `WWW-Authenticate`;
  - `/api/estado` devuelve `accesoControlado: false` y `puedeAdministrar: true`;
  - carga, JSON original, consulta, reemplazo y eliminación funcionan sin
    credenciales;
  - credenciales de piloto, proxy de identidad y localhost siguen como antes.
- **En vivo**: verificado sin credenciales sobre `dep-dbd5qu3l550s73apj9gg`, ya en
  modo `forusguide` (ver "Prueba real en vivo").

## Decisión posterior: consultas con el servicio real de ForUsGuide

El usuario pidió usar el endpoint real de ForUsGuide como motor de consulta, junto con
el acceso sin inicio de sesión. Desde el 2026-10-22 está **conectado y verificado en
vivo** (ver "Prueba real en vivo").

**Llamada directa previa** (autorizada, sin `ticket_id`). Es otra ejecución,
distinta de la prueba en el navegador; sus cifras no se mezclan:

- Petición: `POST https://forusguide.onrender.com/api/v1/knowledge-question` con
  `{"question":"Como hacer un retiro"}` y la `X-API-Key` del servidor.
- Respuesta HTTP 200: respuesta en español sobre retiros de un 401(k), 4 `key_points`,
  8 `source_articles`, 15 `used_chunks`, `confidence_note: well_covered`, modelo
  `gpt-5.4` y `metadata.error` nulo.
- Request ID: `500c1609-7758-429a-929e-0950d90aa806`.
- Los campos coinciden con el adaptador `knowledge-desk-server/src/consulta/forusguide.ts`,
  que no cambia.

**Configuración actual del panel** (`dep-dbd779ifngtc73fron20`, commit `5c1df33`),
alineada con [`render.yaml`](../../render.yaml):

| Situación | Variables |
| --- | --- |
| Fijadas | `KD_MODO=forusguide`, `FORUSGUIDE_API_URL=https://forusguide.onrender.com`, `FORUSGUIDE_API_KEY` (secreta, transferida en privado) y `KD_ACCESO_PUBLICO=true` |
| Sin cambios | Datos temporales en `/tmp` y límite de 10 MB, y `KD_CONTACTO_URL` |
| Retiradas | `KD_ACCESO_BASICO`, `KD_OPERADORES`, `KD_LLM_BASE_URL`, `KD_LLM_API_KEY`, `KD_EMBEDDINGS_MODEL`, `KD_CHAT_MODEL`, `KD_CHAT_REASONING_EFFORT` y `KD_EJEMPLOS_ARCHIVO` (se usa el valor por defecto, `config/ejemplos.json`) |
| No existen | `KD_IDENTIDAD_HEADER`, `KD_PROXY_SECRETO`, `PINECONE_API_KEY` y `PINECONE_INDEX_HOST` |

**Solo consulta.** No hay credenciales de Pinecone, así que Knowledge Desk no tiene
indexación y no escribe, siembra ni borra en el índice compartido. Con el acceso
público, el servidor se niega a arrancar si aparece cualquiera de ellas.

## Prueba real en vivo del 2026-10-22, sin login (ForUsGuide)

Se hizo sobre el despliegue anterior, `dep-dbd5qu3l550s73apj9gg` (commit `4a75c39`),
con un contexto de navegador nuevo y sin credenciales HTTP. Los cambios de `5c1df33`
no forman parte de ella. Aquí no se copia contenido del corpus real.

| Comprobación | Resultado |
| --- | --- |
| Acceso | `/` responde 200 sin `WWW-Authenticate`. Knowledge Desk no recibió ninguna cabecera `Authorization` |
| Estado sin credenciales | `modo` y `consulta.motor`: `forusguide`; `consulta.configurada: true`; `indexacion.configurada: false`; `faltan: ["PINECONE_API_KEY", "PINECONE_INDEX_HOST"]`; `accesoControlado: false`; `accesoPublico: true`; `puedeAdministrar: true`; `simulado: false`; `datosTemporales: true`; usuario "Acceso público" |
| Consulta | "Como hacer un retiro" → `req-ee5c9150`: `engine: forusguide`, `answered`, modelo `gpt-5.4`, 9 fuentes, 14 fragmentos, cobertura alta, `elapsed_ms` 25030 |
| Fuente | Se abrió una fuente externa en `/fuentes/<article_id>` |
| Documentos | Se abrió |
| Errores | Ningún error de JS en el navegador |

**Qué no acredita esta prueba**

- **Calidad**: una consulta no mide el ≥ 85 % de aciertos ni las 20 de 20 consultas
  con fuentes y cobertura.
- **Latencia**: 25 s en una sola consulta. No es una medición, pero queda muy por
  encima de la meta de 2 a 5 s.
- **JSON original externo**: ForUsGuide no lo expone. La fuente muestra fragmentos
  indexados (`/api/v1/chunks`) con ese aviso, y Knowledge Desk no reconstruye el
  original a partir de ellos.
- **Indexación**: no hay carga, reemplazo ni eliminación en este modo.
- **Cambios de `5c1df33`**: el texto de Documentos, el ejemplo de retiro y la
  salvaguarda llegaron después; esta prueba no los cubre.

## Código actual (`5c1df33`)

Desplegado en `dep-dbd779ifngtc73fron20`.

- **[`render.yaml`](../../render.yaml)**: describe el modo actual.
  - Declara `KD_MODO=forusguide`, `FORUSGUIDE_API_URL` y `FORUSGUIDE_API_KEY` con
    `sync: false`.
  - Mantiene `KD_ACCESO_PUBLICO=true`, plan free sin disco, datos temporales y
    10 MB.
  - No declara las variables de OpenAI ni `KD_EJEMPLOS_ARCHIVO`.
- **Salvaguarda**: con `KD_ACCESO_PUBLICO=true` y `KD_MODO=forusguide`, el servidor no
  arranca si aparece `PINECONE_API_KEY` o `PINECONE_INDEX_HOST`.
- **Documentos**: dice "Las consultas usan el corpus de ForUsGuide. Este servidor no
  tiene indexación configurada: aquí no se cargan artículos." La carga está
  desactivada y la lista, vacía. (`4a75c39` mostraba "La indexación no está
  configurada en este servidor.")
- **Ejemplos**: la lista `forusguide` de `config/ejemplos.json` empieza por "¿Cómo hago
  un retiro de mi 401(k)?".
- **Verificado en local** (simuladores de ForUsGuide y Pinecone, sin servicios
  reales; 103 pruebas del servidor y 83 de interfaz):
  - consulta con la clave del servidor y solo la pregunta en el cuerpo;
  - fuente externa como fragmentos indexados;
  - carga rechazada con `INDEX_NOT_CONFIGURED` y ninguna petición a Pinecone;
  - ejemplos sin verificar;
  - la salvaguarda y el texto de Documentos.

**Limitaciones del modo `forusguide`** (detalle en la
[matriz](MATRIZ_CRITERIOS.md)):

- ForUsGuide arma el contexto: Knowledge Desk no puede filtrar antes. En esta
  configuración no hay versiones propias que excluir.
- Sin JSON original de los artículos externos.
- Sin citas por afirmación ni contradicciones.
- Ejemplos sin verificar: hacerlo exige leer el índice, y la vista pública no admite
  credenciales de Pinecone.
- Calidad sin medir y latencia observada de 25 s, fuera de la meta.

## Smoke real del 2026-10-22 (18:21–18:25 UTC), con acceso protegido (histórico)

Se hizo sobre el despliegue `9337e67`, que aún exigía credenciales de piloto. Usó un
artículo **sintético** (datos ficticios, sin corpus privado) y contaba con
autorización.

| Comprobación | Resultado |
| --- | --- |
| Salud y acceso | `/api/salud` público responde 200. `/` sin credencial responde 401 y con credencial 200 |
| Estado | `modo: local`, `faltan: []`, `simulado: false`, `datosTemporales: true` |
| Carga | `DOC-0001`, operación `OP-2026-0001`: v1.0 Indexado, 7 de 7 embeddings confirmados |
| Consulta | `req-fa4d9a2f`: `answered`, `generated: true`, modelo `gpt-6-luna`. Respuesta con el plazo de 15 días y fuente v1.0 `details.business_rules[1]`; `elapsed_ms` 1984 |
| JSON original v1.0 | Idéntico byte a byte: 2633 bytes, SHA-256 `7c30b12f4383bbf0b9f27cb2263c94db9eedda65f07c0602b6bb2acc48949634` |
| Reemplazo | `OP-2026-0002` exitoso: v1.1 activa con 6 de 6 embeddings y los 7 fragmentos de v1.0 retirados |
| Consulta | `req-a449f165`: `answered`, plazo de 10 días hábiles, fuente v1.1; `elapsed_ms` 1929 |
| JSON original v1.1 | Idéntico byte a byte: 2382 bytes, SHA-256 `d153ca8b0bdd1ab1bedb7eb4c7d9dd4c54f7d448f0fdb827cfbc8bed53e0bbf6` (esta versión sintética no está en el repositorio) |
| Eliminación | `OP-2026-0003` exitosa: 6 de 6 fragmentos y embeddings retirados, registro retirado, lista de documentos vacía |
| Consulta tras eliminar | `req-80d60bbc`: `insufficient`, `answer: null`, `sources: []`, `generated: false` |
| Interfaz (Playwright contra el despliegue) | Pasaron, sin errores de página: Consulta, Documentos, aviso de datos temporales, visor formateado y exacto, SHA-256, enlace de descarga, consulta del procedimiento, abrir la fuente y rutas resaltadas |

Al terminar quedó cargado otro ejemplar del mismo artículo sintético: `DOC-0002`
v1.0, `OP-2026-0004`, 7 de 7 embeddings. Como los datos son temporales, desaparece
cuando el servicio se suspende o se reinicia.

## Qué no acredita este smoke

- Eliminación parcial con reintento y rechazo de la credencial del proveedor: solo
  están probados en local con servicios simulados.
- Calidad (≥ 85 % de aciertos, 20 de 20 consultas con fuentes y cobertura) y
  latencia: no se midieron. Dos consultas de unos 2 s no son una medición de
  latencia.
- Corpus real, modo `forusguide`, ForUsGuide y Pinecone reales. La consulta con
  ForUsGuide se verificó después, en la prueba en vivo.
- Persistencia de datos: este entorno no la tiene por diseño.

## CI de los commits desplegados

Es la suite versionada, con servicios simulados; no llama a servicios reales.

| Commit | Run | Resultado |
| --- | --- | --- |
| `5c1df33` (actual) | [`39850199650`](https://github.com/ialvisti/Knowledge-Desk/actions/runs/39850199650) | Estado en el enlace |
| `4a75c39` (histórico) | [`39835813660`](https://github.com/ialvisti/Knowledge-Desk/actions/runs/39835813660) | **Éxito**: 98 pruebas del servidor, 81 de navegador y E2E, build, typecheck, lint y auditorías `npm` |
| `9337e67` (histórico) | [`39829353927`](https://github.com/ialvisti/Knowledge-Desk/actions/runs/39829353927) | **Éxito** (12 min 44 s): 92 pruebas del servidor, 77 de navegador y E2E, build, typecheck, lint y auditorías `npm` |

## Probarla con ForUsGuide (actual)

1. Abre <https://knowledge-desk-preview.onrender.com>: entras sin login. Si el
   servicio dormía, la primera carga tarda.
2. En **Consulta**, elige un ejemplo o pregunta, por ejemplo, "Como hacer un retiro".
   En la prueba en vivo, la respuesta tardó unos 25 s.
3. Abre una fuente: verás sus fragmentos indexados en ForUsGuide, no el JSON original.
4. **Documentos** explica que las consultas usan el corpus de ForUsGuide y no permite
   cargar.

## Probarla con el artículo sintético (modo `local`, histórico)

Solo sirve con un despliegue en modo `local`, como `9337e67`. En la vista previa
actual (modo `forusguide`), Documentos no permite cargar.

1. Descarga [`demo/articulo-sintetico-viaticos.json`](../../demo/articulo-sintetico-viaticos.json).
   Es el artículo de la v1.0 del smoke ("Ejemplo SINTÉTICO: viáticos
   internacionales"): datos ficticios, marcados así en el título y la descripción.
2. Abre <https://knowledge-desk-preview.onrender.com>.
   - Con el acceso público desplegado, entras directamente.
   - El despliegue `9337e67` pedía las credenciales de piloto.
   - Si el servicio dormía, la primera carga tarda.
3. En **Documentos**, pulsa **Explorar archivos** (o arrastra el archivo) y
   selecciónalo.
4. Espera a que su estado pase a **Indexado**: la lista se actualiza sola.
   - Si responde que el artículo ya existe, es que sigue cargado: pasa al punto 5 o
     usa **Editar** para reemplazarlo.
5. En **Consulta**, pregunta, por ejemplo, "¿En qué plazo se solicita el reembolso de
   viáticos internacionales después del viaje?". También puedes elegir uno de los
   ejemplos, que aparecen mientras el artículo está cargado.
6. Abre la fuente de la respuesta para ver el JSON original con las rutas usadas
   resaltadas.

Si Documentos aparece vacío, el servicio se suspendió o se reinició: vuelve a cargar el
archivo.

El archivo del repositorio tiene finales de línea LF: 2633 bytes y el SHA-256 de la
v1.0 de arriba. La regla `demo/articulo-sintetico-viaticos.json -text` de
[`.gitattributes`](../../.gitattributes) impide que Git convierta sus finales de línea,
así que cualquier checkout conserva esos bytes.
