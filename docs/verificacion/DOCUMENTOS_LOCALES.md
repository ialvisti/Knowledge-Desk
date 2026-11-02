# Documentos en el navegador: guía de prueba y alcance

Gestión de documentos para presentar en clase (HU07–HU09): carga, persistencia,
reemplazo confirmado, eliminación confirmada, mensajes de éxito y error, y búsqueda de
fragmentos. Preparada para la vista previa de Render, que es **solo consulta** con
ForUsGuide, sin disco, sin servicios de pago y sin secretos en el navegador.

La interfaz usa nombres normales (**Documentos**, **Indexado**, **Buscar en
documentos**). La única indicación visible del almacenamiento es una nota discreta:
"Tus archivos se guardan en este navegador. En una ventana privada se pierden al
cerrarla." La nota añade que Consulta responde con el corpus de ForUsGuide. El
detalle técnico está plegado en *Detalles de almacenamiento* y en esta guía.

## Alcance técnico (lo que es y lo que no es)

| Es | No es |
| --- | --- |
| Documentos guardados en **IndexedDB del navegador**: archivo original, texto extraído, fragmentos y registro técnico. | El corpus de ForUsGuide ni el del servidor de Knowledge Desk. Nada se envía a Render, a ForUsGuide ni a Pinecone. |
| PDF, DOCX, TXT y artículos JSON kb_article_v2, hasta **50 MB** por archivo y **20 MB de texto extraído**. | Indexación semántica: no hay embeddings, vectores ni modelo de IA. "Indexado" significa que el texto quedó extraído y fragmentado para la búsqueda. |
| **Buscar en documentos**: coincidencia de palabras sobre los fragmentos, con el texto literal y su documento y versión. | Una respuesta redactada. Consulta (`/`) sigue respondiendo solo con ForUsGuide. |
| Una colección por navegador y por dirección (origen). | Algo compartido: otros usuarios, equipos, navegadores o direcciones no la ven. `localhost` y Render guardan colecciones distintas. |

- **Duración.** Persiste al recargar y al cerrar el navegador. Se pierde:
  - al cerrar una ventana privada;
  - al borrar los datos del sitio;
  - si el navegador libera el espacio porque se queda sin almacenamiento.

  El pie de Documentos muestra la estimación de espacio del navegador.
- **Extracción.** Se hace en el navegador:
  - PDF: solo texto seleccionable, **sin OCR**; un PDF escaneado se rechaza por no
    tener texto.
  - DOCX: **básica**, solo los párrafos del cuerpo; sin encabezados, pies,
    comentarios ni imágenes.
  - TXT: UTF-8.
  - JSON: debe tener `metadata.article_id`, `metadata.title` y `details`.
  - Si el texto extraído supera 20 MB, el archivo se rechaza con su motivo.
- **Atomicidad.** Carga, reemplazo y eliminación son cada uno una transacción de
  IndexedDB. Si falla, no queda nada a medias y la interfaz relee lo guardado para
  informarlo.
- **Contexto seguro.** Requiere HTTPS o `localhost`/`127.0.0.1` (SHA-256 e
  identificadores del navegador).

## Rutas

| Ruta | Qué muestra |
| --- | --- |
| `/documentos` | Abre estos documentos **automáticamente** cuando el servidor declara `indexacion.configurada: false` (Render). Con indexación real conserva la administración del servidor y añade el enlace "Documentos de este navegador". Mientras no llega `/api/estado`, no presupone ninguna capacidad. |
| `/documentos?coleccion=local` | Los documentos del navegador, sea cual sea el servidor. |
| `/documentos/local/:id` | Documento: texto extraído, fragmentos, SHA-256 verificado, *Descargar original* con su nombre real y *Registro técnico*. Para JSON, también el visor JSON. |
| `/consulta-local` | **Buscar en documentos**. Enlazada desde Documentos y desde Consulta. |

## Archivos de ejemplo

Ficticios, en [`demo/documentos-locales/`](../../demo/documentos-locales/):

- `politica-viaticos-v1.{pdf,docx,txt}`: auxilio diario de **120000 COP**, legalización
  en 5 días hábiles.
- `politica-viaticos-v2.{pdf,docx,txt}`: la versión nueva, con **180000 COP** y 3 días.
- `error-sin-texto.txt`: solo espacios; debe rechazarse.

## Prueba manual (unos 5 minutos)

1. Abre `/documentos?coleccion=local` en el equipo de presentación. Después del
   despliegue, `/documentos` también abre esta vista en Render. Bajo el título
   **Documentos** aparece la nota discreta de almacenamiento. *Detalles de
   almacenamiento* despliega el alcance técnico.
2. **Carga.** En *Cargar documento*, pulsa *Explorar archivos* o arrastra
   `politica-viaticos-v1.pdf` y `error-sin-texto.txt`. Resultado esperado:
   - el PDF pasa por *Procesando…* y queda **Indexado** (texto normal, sin chip), con
     su número de fragmentos;
   - el TXT vacío muestra un error con el motivo y *Volver a seleccionar*, y no crea
     ninguna fila.
3. **Recarga** la página (F5): el documento sigue ahí.
4. **Documento.** Abre su nombre: aparece el texto extraído con 120000 COP y el SHA-256
   "Archivo guardado íntegro". *Descargar original* baja el mismo archivo con su
   nombre.
5. **Búsqueda.** Pulsa **Buscar en documentos** y pregunta "¿Cuál es el auxilio diario
   de viáticos?". Aparece el fragmento con el documento enlazado y su versión v1.
6. **Reemplazo.** En Documentos, usa el lápiz. El diálogo **Reemplazar documento**
   identifica el archivo actual. Elige `politica-viaticos-v2.docx`, marca la
   confirmación y pulsa *Reemplazar documento*. Resultado esperado:
   - "Documento reemplazado", con el registro técnico;
   - el mismo ID, ahora en v2 y con el nombre nuevo;
   - la búsqueda devuelve solo 180000 COP.
7. **Error de reemplazo.** Las pruebas lo provocan inyectando un `QuotaExceededError`
   controlado. A mano, se ve si el navegador se queda sin espacio. El diálogo "No se
   pudo reemplazar el documento" dice:
   - el motivo;
   - que se conserva la versión anterior, comprobado releyendo el almacenamiento;
   - y ofrece *Reintentar* o *Elegir otro archivo*.
8. **Eliminación.** Usa la papelera. En **¿Eliminar este documento?** marca "Entiendo
   las consecuencias…" y pulsa *Eliminar documento*. Resultado esperado:
   - "Documento eliminado", con los fragmentos retirados, la comprobación de que ya
     no está guardado y el registro técnico, que indica el almacenamiento real;
   - la fila desaparece y la búsqueda ya no lo encuentra.

   No se muestran conteos de embeddings porque no existen.
9. **Móvil.** Repite la carga en 375 px: la tabla se convierte en tarjetas y los
   diálogos ocupan el ancho disponible.

Los nombres accesibles de algunos controles conservan la palabra "local" para las
pruebas y los lectores de pantalla:

- *Seleccionar documentos locales* y *Seleccionar reemplazo local*;
- los diálogos *Reemplazar documento local* y *¿Eliminar este documento local?*;
- el campo *Pregunta sobre tus documentos locales*.

## Evidencias

La [galería de las 10 capturas](documentos-locales/index.html) permite revisar y
abrir cada PNG con su explicación. El [registro de validación](documentos-locales/validacion.json)
recoge los comandos y resultados de la revisión del 1 de noviembre de 2026.

Las capturas reales del flujo se guardan en
[`documentos-locales/`](documentos-locales/), separadas de las 23 capturas históricas
del servidor de esta carpeta, que no se sobrescriben. Las genera
`knowledge-desk-ui/tests/capturas/documentos-locales.spec.ts`. Usa IndexedDB real,
extracción PDF/DOCX real y la API de capacidades sustituida con el estado de Render.
No hay ninguna escritura en el índice remoto. El mismo spec escribe `procedencia.json`
con la fecha, el método del fallo controlado y el comando:

```powershell
cd knowledge-desk-ui
npx playwright test tests/capturas/documentos-locales.spec.ts --project=capturas
```

Las pruebas funcionales están en `knowledge-desk-ui/tests/ui/documentos-locales.spec.ts`
(proyectos `escritorio` y `movil`). Cubren:

- carga, recarga y descarga byte a byte;
- reemplazo con éxito y con error de cuota;
- eliminación con éxito y con error;
- rechazo de formatos, vacíos y archivos de más de 50 MB;
- extracción real de PDF y DOCX;
- ninguna petición de escritura a `/api/documentos`.

Este documento no registra resultados de ejecución. Estos cambios están incluidos en
la versión preparada para publicación; el despliegue se verifica en
[DEPLOY_RENDER.md](DEPLOY_RENDER.md).
