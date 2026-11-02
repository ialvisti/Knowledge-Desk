# Knowledge Desk: interfaz

Aplicación React 19 + Vite 8 + Tailwind 4 en español. Solo habla con el **servidor de
Knowledge Desk** (`../knowledge-desk-server`), nunca con ForUsGuide, Pinecone ni un
proveedor de IA. No existe ninguna variable `VITE_*`: la interfaz no recibe credenciales.

Las instrucciones de instalación, arranque y verificación para Windows están en el
[README principal](../README.md).

## Pantallas

| Ruta | Función | Referencia de diseño |
| --- | --- | --- |
| `/` | Consulta: buscador y ejemplos verificados contra el corpus (HU01, HU06) | PDF `Consulta — Knowledge Desk` |
| `/resultados?q=` | Respuesta sustentada, puntos clave, cobertura, fuentes con su ruta JSON, insuficiencia y errores con ID de soporte (HU03–HU05, HU10) | PDF `Resultados — Knowledge Desk`; PNG de errores e insuficiencia |
| `/documentos` | Con indexación en el servidor: artículos JSON, carga, filtro por nombre, estados reales, reemplazo y eliminación con fallo parcial (HU07–HU09). Sin indexación (`indexacion.configurada: false`, vista previa de Render): abre la colección local. Mientras no llega `/api/estado` no presupone ninguna capacidad | PNG `Vista de documentos` y diálogos |
| `/documentos?coleccion=local` | Documentos del navegador (IndexedDB): PDF, DOCX, TXT y JSON hasta 50 MB, carga múltiple o por arrastre, filtro por nombre, estados *Procesando…* e *Indexado* en texto normal, reemplazo y eliminación confirmados con su registro técnico. Solo una nota discreta indica que se guardan en el navegador; el detalle técnico va plegado | Mismos diálogos que `/documentos` |
| `/documentos/local/:id` | Documento local: texto extraído, fragmentos, SHA-256 verificado, descarga del original con su nombre y registro técnico (visor JSON si es un artículo) | Sin referencia (ampliación) |
| `/consulta-local?q=` | **Buscar en documentos**: coincidencia de palabras sobre los documentos del navegador, sin generación de respuestas. Muestra fragmentos literales con su documento y versión vigentes | Sin referencia (ampliación) |
| `/documentos/:id?version=` | Visor del JSON auténtico de la versión: formateado o exacto, rutas usadas resaltadas, copia, descarga, SHA-256 verificado en el navegador, fragmentos indexados y registro técnico | Sin referencia (ampliación) |
| `/fuentes/:articleId` | Artículo del corpus de ForUsGuide: sus fragmentos indexados, con aviso de que no es el JSON original | Sin referencia (ampliación) |

## Comportamiento que conviene conocer

- **Cada consulta es independiente.** Solo viaja `{question}`. La caché es de
  **navegación** (atrás y adelante), no conversacional.
- **Una respuesta nunca sobrevive a un cambio del corpus.** Cada respuesta va asociada
  a su `corpus_revision`, y la revisión se revalida al navegar, al volver a la pestaña
  y cuando otra pestaña avisa (BroadcastChannel). Antes de reutilizar una respuesta al
  volver atrás, se comprueba con el servidor; si no se puede comprobar, no se muestra y
  se ofrece reintentar. Una respuesta de un corpus anterior se repite como máximo 2
  veces y después se informa `CORPUS_CHANGED`.
- **Una petición cancelada no se envía** (`api/cliente.ts`).
- **Modo demostración**: si el servidor informa `simulado: true`, el pie de Consulta, el
  aviso de Resultados, el pie de Documentos y la sesión lo dicen, y no se muestra
  ningún nombre de modelo.
- **La colección local no sale del navegador.**
  - Vive en IndexedDB, por navegador y por origen; `localhost` y Render tienen
    colecciones distintas.
  - No llama a `/api/documentos` ni a `/api/consulta`, y no alimenta Consulta.
  - El visor y la búsqueda se vuelven a leer cuando el motor avisa de un cambio
    (también desde otra pestaña, por BroadcastChannel). Un documento reemplazado o
    borrado no se muestra con datos anteriores, tampoco al volver atrás.
  - Tras un fallo o un borrado, los diálogos releen IndexedDB y dicen lo que de verdad
    quedó guardado.

## Organización

- `src/api`: cliente HTTP con el contrato de error de HU10, servicios y tipos.
- `src/state`: revisión del corpus y caché de navegación (`consultas.ts`), y estado del
  servidor con revalidación (`servidor.tsx`).
- `src/local`: motor de la colección local. Contiene la extracción de PDF y DOCX en el
  navegador, la fragmentación, las transacciones de IndexedDB, el registro y la
  búsqueda por términos.
- `src/hooks`: consulta, ejemplos, seguimiento de operaciones y colección local
  (`useColeccionLocal.ts`).
- `src/components`: tarjetas de consulta, diálogos de documentos (del servidor y
  locales), modal, visor JSON y controles.
- `src/pages`: las cinco pantallas, la 404 y las tres de la colección local
  (`DocumentosLocales`, `DocumentoLocal` y `ConsultaLocal`).
- `src/index.css` y `src/ampliacion.css`: estilos. La geometría de Documentos está
  medida sobre la referencia de 1848 × 692.

## Pruebas (Playwright)

| Proyecto | Qué hace |
| --- | --- |
| `escritorio` y `movil` | Estados de la interfaz con el servidor sustituido en el navegador (`tests/ui/fixtures.ts`): HU01, HU03–HU07 y HU10, y las carreras U1, U2 y U3. `documentos-locales.spec.ts` prueba la colección local con IndexedDB, extracción y búsqueda reales; solo se sustituye `/api/estado`. |
| `e2e` | Flujo completo contra el servidor **real** en modo simulado: carga JSON, consulta, visor, reemplazo, eliminación parcial y error de consulta. |
| `capturas` | Capturas finales en `../docs/verificacion` y `comparacion.html`, contra el servidor en modo simulado y con estados reales del pipeline. Las de la colección local van aparte, en `../docs/verificacion/documentos-locales/`. |

`npm test` ejecuta `escritorio`, `movil` y `e2e`. `npm run capturas` ejecuta las
capturas. Playwright levanta el stack simulado en los puertos 8789, 8792 y 8793 y Vite
en el 5174, así que no choca con una demo abierta en 5173 y 8788.
