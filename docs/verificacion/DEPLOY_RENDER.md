# Vista previa en Render: registro del despliegue

## Servicio

| Dato | Valor |
| --- | --- |
| URL | <https://knowledge-desk-preview.onrender.com> |
| Servicio y despliegue | `srv-dbd57prncjis73b619sg` · `dep-dbd57qbncjis73b61bi0` |
| Plan | **Free**, región Oregon, **sin disco**, `autoDeploy` desactivado |
| Código desplegado | `main`, commit `9337e67d924b3492d245c6423cb01513508b8a2e` ([`render.yaml`](../../render.yaml) de ese commit) |
| Modo | `KD_MODO=local`: corpus propio y proveedor OpenAI. No usa ForUsGuide ni Pinecone |
| Modelos | Chat `gpt-6-luna` con `KD_CHAT_REASONING_EFFORT=none`; embeddings `text-embedding-3-small` |
| Datos | `KD_DATA_DIR=/tmp/knowledge-desk`, `KD_DATOS_TEMPORALES=true`, JSON de hasta 10 MB |
| Secretos | La clave del proveedor y las credenciales de acceso están **solo** en el panel de Render. No están en el repositorio ni en este registro; pídelas al responsable del despliegue |

## Restricciones de esta vista previa

- **Los datos son temporales.**
  - Sin disco, el corpus, el registro y el índice viven en el sistema de archivos
    efímero de la instancia.
  - Render suspende un servicio gratuito tras unos 15 minutos sin tráfico; la primera
    petición al despertarlo tarda más.
  - Al despertar, reiniciar o redesplegar, los artículos cargados **se pierden** y
    hay que volver a cargarlos. El pie de Documentos lo avisa.
- **Coste.** El cómputo es del plan gratuito. Cada carga (embeddings) y cada consulta
  (embeddings y chat) llaman a la API real de OpenAI y consumen su cuota. No hay plan
  de cómputo de pago ni disco.
- **Acceso.** Todo exige las credenciales de piloto (HTTP Basic), salvo `/api/salud`.
- **Arranque.** Nada se carga solo al arrancar: el corpus se sube a mano desde
  Documentos.

## Smoke real del 2026-10-22 (18:21–18:25 UTC)

Se hizo con un artículo **sintético** (datos ficticios, sin corpus privado) y con
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
- Corpus real, modo `forusguide`, ForUsGuide y Pinecone reales.
- Persistencia de datos: este entorno no la tiene por diseño.

## CI del commit desplegado

La run [`39829353927`](https://github.com/ialvisti/Knowledge-Desk/actions/runs/39829353927)
sobre `9337e67` terminó en **éxito** (12 min 44 s):

- 92 pruebas del servidor;
- 77 pruebas de navegador y E2E;
- build, typecheck y lint;
- auditorías `npm`.

Es la suite versionada, con servicios simulados; no llama a servicios reales.

## Probarla con el artículo sintético

1. Descarga [`demo/articulo-sintetico-viaticos.json`](../../demo/articulo-sintetico-viaticos.json).
   Es el artículo de la v1.0 del smoke ("Ejemplo SINTÉTICO: viáticos
   internacionales"): datos ficticios, marcados así en el título y la descripción.
2. Abre <https://knowledge-desk-preview.onrender.com> e identifícate con las
   credenciales de piloto. Si el servicio dormía, la primera carga tarda.
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
