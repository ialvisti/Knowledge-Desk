# Siete casos del plan de pruebas: verificación local del 2026-11-03

Estado: verificado en local con pruebas automáticas y una prueba real contra Pinecone y
OpenAI. Todavía no está desplegado en Render.

## Resultado de las pruebas automáticas

- Servidor: 194 de 194 pruebas (`npm test` en `knowledge-desk-server`), más typecheck y lint.
- Interfaz: 143 de 143 pruebas (escritorio, móvil y e2e), más build y lint.
- `npm run verificar` terminó sin errores y `npm audit --audit-level=moderate` no
  encontró vulnerabilidades ni en el servidor ni en la interfaz.

## Casos

| Fila | Caso | Qué se comprueba | Prueba |
| --- | --- | --- | --- |
| 57 | CP-HU07-03 | Un PDF con texto, un DOCX y un TXT reales se cargan por separado por la API. Se procesan en el servidor y se conserva la asociación entre el original (byte a byte, con su SHA-256), el texto extraído y los fragmentos con sus embeddings. | `knowledge-desk-server/test/documentos-texto.test.ts` |
| 43 | CP-HU05-03 | Fronteras de la política de cobertura con los umbrales aprobados: relevancia 0,20, media 0,22 y alta 0,35. Cada umbral T se prueba con T − d, T y T + d, con d = 1e-6 y con 1 ULP. El nivel alto usa dos fragmentos únicos. T queda incluido (regla "mayor o igual"). | `knowledge-desk-server/test/umbrales.test.ts` |
| 58 | CP-HU07-04 | Un PNG (también renombrado a .pdf o .txt) se rechaza con 415 y un mensaje claro. No se crea documento, archivo, fragmento ni embedding, y no hay llamadas a Pinecone ni al modelo. | `knowledge-desk-server/test/documentos-texto.test.ts` |
| 60 | CP-HU07-06 | Documento con texto conocido: se completan extracción, fragmentación, clasificación, embeddings, verificación y activación. Cada fragmento tiene el tipo esperado y su embedding pertenece al documento correcto. El documento aparece como fuente en una consulta. | `knowledge-desk-server/test/documentos-texto.test.ts` |
| 86 | CP-HU10-01 | Pregunta válida: respuesta, puntos clave, fuentes no vacías y asociadas a los fragmentos recuperados, cobertura y estado coherentes. Mismo contrato en `POST /api/consulta` y en `POST /api/v1/knowledge-question`. | `knowledge-desk-server/test/api-contrato-errores.test.ts` |
| 87 | CP-HU10-02 | Pregunta vacía, solo espacios, nula y omitida, en los dos endpoints: error de validación 422 antes de recuperar o generar (0 búsquedas y 0 llamadas al modelo). | `knowledge-desk-server/test/api-contrato-errores.test.ts` |
| 92 | CP-HU10-07 | Errores de validación, recuperación, base vectorial e IA, en los dos endpoints, provocados a través de los adaptadores reales (SDK de Pinecone y cliente del proveedor). Se ponen canarios en cuerpos, cabeceras, mensajes, causas y trazas. Ningún canario, clave, token, cadena de conexión ni traza aparece en los cuerpos, campos o cabeceras públicos. | `knowledge-desk-server/test/api-contrato-errores.test.ts` |

## Prueba real local

La evidencia saneada está en
[SIETE_CASOS_PRUEBA_REAL_2026-11-03.json](SIETE_CASOS_PRUEBA_REAL_2026-11-03.json).
El servidor de Knowledge Desk corrió en local en modo `directo`, con Pinecone y OpenAI
reales.

- Se cargaron por la API tres documentos sintéticos (TXT, DOCX y PDF), sin datos
  personales. Los tres quedaron indexados solo en el namespace
  `knowledge_desk_documents`, con el original idéntico y el texto extraído correcto.
  Pinecone confirmó un embedding por fragmento, asociado al documento correcto.
- Una consulta completa a `POST /api/v1/knowledge-question` respondió con la
  información del documento sintético, citado como fuente.
- El namespace base `kb_articles` tenía 936 registros antes y 936 después de la prueba:
  no se modificó.
- Al terminar, los tres documentos sintéticos se eliminaron por la API. Solo se borraron
  sus propios identificadores y no quedó ninguno en el índice.

## Pendiente

- Desplegar en Render y repetir allí el plan de prueba de
  [DEPLOY_RENDER.md](DEPLOY_RENDER.md).
