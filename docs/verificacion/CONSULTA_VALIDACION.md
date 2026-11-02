# Validación de la consulta y respuestas sin sustento

Registro del caso reportado el 2026-11-01 sobre la consulta de Knowledge Desk: qué se
reportó, qué se observó en los servicios reales, qué se corrigió y qué queda
pendiente.

- Los cambios están publicados en Render desde el 2026-11-01. El despliegue y la CI
  se registran en [DEPLOY_RENDER.md](DEPLOY_RENDER.md).
- La comprobación sobre la URL pública está en
  [render-publico-20261101.json](consulta-validacion/render-publico-20261101.json):
  la pregunta de 1036 caracteres se rechaza y la de 100 devuelve insuficiencia,
  sin respuesta generada ni fuentes presentadas como sustento.

## Lo reportado

La captura de Resultados muestra una pregunta sobre vacaciones repetida varias veces.
La respuesta se presenta como válida y empieza con "No tengo información en el
contexto proporcionado sobre el proceso para solicitar vacaciones..."; después habla de
planes 401(k).

Quien lo reportó esperaba un error con una pregunta de más de 100 caracteres. El
"401" de la captura es parte de "401(k)", no un HTTP 401.

## Decisión sobre la longitud

**Máximo de 100 caracteres.** El usuario lo confirmó el 2026-11-01 y sustituye al
máximo de 2000 que había antes.

- Se cuentan puntos de código después de quitar los espacios de los extremos, igual
  en el servidor y en la interfaz.
- La frase de la captura, "¿Cuál es el proceso para solicitar mis vacaciones y a quién
  debo enviar la solicitud para aprobarla?", mide exactamente 100 caracteres y es
  válida.
- La pregunta enviada en Render repetía esa frase 9 veces unidas por " La pregunta es:
  " (1036 caracteres). Ahora se rechaza antes de llamar a ForUsGuide.

**Mínimo de 10 caracteres.** Se conserva la configuración heredada, alineada con el
backend de ForUsGuide según el código. Ninguna historia de usuario lo fija:

- HU01 (página 5 de `docs/negocio/RQ01v1_Historia_de_Usuario_Knowledge_Desk_16092026_V1.pdf`)
  solo exige rechazar la pregunta vacía o de solo espacios;
- HU10 (página 15) exige validar antes de recuperar o generar.

## Evidencia real

Son dos llamadas distintas con la misma pregunta de 1036 caracteres. El servicio
externo varía entre llamadas, así que ninguna de las dos describe con certeza la
siguiente.

| Dato | Render publicado (request_id `req-bcaec51a`) | Llamada pública directa a ForUsGuide (`POST /api/v1/knowledge-question`) |
| --- | --- | --- |
| Resultado | `answered`; Cobertura parcial con `basis: motor`, es decir, ForUsGuide declaró `partially_covered` | `confidence_note: limited_coverage` |
| Fragmentos y artículos | 22 fragmentos relevantes de 9 artículos | 23 `used_chunks` de 11 artículos |
| Mejores afinidades | 0,35; 0,33; 0,32; 0,32; 0,32, redondeadas por Knowledge Desk | 0,3325; 0,3213; 0,3206; 0,3079; 0,3053 (media de las 5 mejores: 0,31752) |
| Vacíos declarados | Desconocidos: el contrato de Knowledge Desk no los expone | Uno solo: "Proceso para solicitar vacaciones o PTO y la persona/equipo que debe aprobar o recibir esa solicitud" |
| Respuesta | Admite no tener información sobre vacaciones y describe temas de 401(k) | Admite que el tema no aparece en el contexto y describe temas de 401(k) |

La llamada directa se hizo sin credencial y el servicio respondió. Esto no coincide
con lo que documenta `docs/CONTRATO_KNOWLEDGE_QUESTION.md` sobre la `X-API-Key`, y
queda pendiente de confirmar con quien opera ForUsGuide.

## Diagnóstico

1. **Código desplegado.** La política respetaba el nivel declarado por el motor e
   ignoraba los vacíos y las afinidades. Con `partially_covered`, la respuesta de
   Render se presentó con Cobertura parcial, como muestra la captura.
2. **Primera corrección de esta revisión.** Bajaba el nivel con dos o más vacíos y
   limitaba a `parcial` con uno.
   - Se verificó con un fixture artificial de dos vacíos, que no representa lo
     observado.
   - Con un solo vacío y `partially_covered`, una evidencia tan débil como la de la
     llamada directa se habría seguido presentando.
   - Además contaba los vacíos sin normalizarlos: blancos o repetidos podían
     convertir un vacío en dos y bajar la cobertura por error.
3. **Corrección actual.** La política calcula su nivel con la misma regla de siempre,
   y el nivel del motor actúa como techo: se usa el menor de los dos.
   - **Vacíos.** Se normalizan antes de contarlos: sin espacios sobrantes, sin
     blancos y sin repetidos, aunque cambien las mayúsculas.
   - **Con 2 o más vacíos:** `baja`.
   - **Con 1 vacío:** `parcial` solo si la media de las 5 mejores afinidades llega a
     `KD_COBERTURA_ALTA` (0,35) y hay al menos 2 fragmentos relevantes; si no, `baja`.
   - **Sin vacíos:** `alta`, `parcial` o `baja` según la media, como antes.
   - La evidencia y los vacíos solo pueden bajar el nivel del motor, nunca subirlo.
   - No hay reglas sobre el tema, el idioma ni las frases de la respuesta.
4. **Aplicada a la evidencia observada.** Con un vacío y una media de 0,31752, la
   política da `baja`. Así, tanto `limited_coverage` (llamada directa) como
   `partially_covered` con esa misma evidencia (variante de regresión) terminan como
   insuficiencia: sin respuesta, sin puntos clave y sin fuentes como sustento.

## Cambios

- **Servidor:**
  - `knowledge-desk-server/src/consulta/validate.ts`: máximo de 100;
  - `knowledge-desk-server/src/consulta/coverage.ts`: techo del motor con la regla
    existente y vacíos normalizados.
  - Los ejemplos configurados y `/api/estado` usan la misma constante; todos los
    ejemplos de `config/ejemplos.json` miden 100 caracteres o menos.
- **Interfaz:**
  - `knowledge-desk-ui/src/api/servicios.ts`: máximo de 100;
  - `components/SearchForm.tsx` y `components/consulta.tsx`: indicador "N de 100
    caracteres", que se marca en rojo al superar el máximo;
  - mensajes con la longitud real, sin `maxLength` (no se recorta al pegar), y una
    pregunta fuera de rango, escrita o en la URL `/resultados?q=`, no se envía.
- **Búsqueda en documentos del navegador** (`pages/ConsultaLocal.tsx`): conserva su
  límite propio de 2000. Ahora es una constante local para que el nuevo máximo no le
  afecte.
- **Pruebas:**
  - `knowledge-desk-server/test/consulta-validacion.test.ts`, reescrita con los
    valores observados;
  - `knowledge-desk-ui/tests/ui/consulta-validacion.spec.ts`;
  - `knowledge-desk-ui/tests/capturas/consulta-validacion.spec.ts`;
  - fixtures en `knowledge-desk-ui/tests/ui/fixtures.ts`;
  - `knowledge-desk-server/test/local.test.ts`: una pregunta de 101 caracteres pasó a
    una equivalente de 91.

## Comportamiento resultante

| Entrada | Ahora |
| --- | --- |
| 9 caracteres, 101 caracteres (ASCII, ñ o emoji) o la pregunta reportada de 1036, en el formulario o en la URL | No se envía. El mensaje indica la longitud, la tarjeta dice "Sin ID de soporte: la solicitud no se envió." y el texto queda completo para corregirlo |
| 10, 99 o 100 caracteres, incluidos 100 emojis (200 unidades UTF-16) | Se envía completa |
| Texto pegado de 150 caracteres | Se conserva completo; el indicador marca "150 de 100 caracteres" y no se envía |
| Cuerpo de más de 64 KB en `POST /api/consulta` | 422 `VALIDATION_ERROR`, sin llamar a ForUsGuide |
| URL de unos 24 KB (2000 emojis) | El servidor HTTP responde 431 antes de cargar la aplicación; no hay consulta |
| Evidencia observada con `limited_coverage` o con `partially_covered` y un vacío | `insufficient` |
| Vacíos repetidos o en blanco con evidencia fuerte y `well_covered` | Cuentan como uno: `parcial`, y se presenta |
| ForUsGuide responde 401 o 403 | `UPSTREAM_AUTH_ERROR` (502), nunca insuficiencia |

## Pruebas y resultados (2026-11-01, tras la decisión de 100)

| Comando | Resultado |
| --- | --- |
| `node --test test/consulta-validacion.test.ts`, en `knowledge-desk-server` | 10 de 10 correctas |
| `npm test`, en `knowledge-desk-server` | 113 de 113 correctas |
| `npx tsc --noEmit` y `npx oxlint src test`, en `knowledge-desk-server` | Sin errores |
| `npx playwright test tests/ui/consulta-validacion.spec.ts tests/ui/consulta.spec.ts --project=escritorio --project=movil` | 82 de 82 correctas |
| `npx playwright test --project=escritorio --project=movil --project=e2e`, en `knowledge-desk-ui` | 135 de 135 correctas, incluidos documentos y documentos del navegador |
| `npm run build` y `npx oxlint`, en `knowledge-desk-ui` | Sin errores |
| `npx playwright test tests/capturas/consulta-validacion.spec.ts --project=capturas` | 1 correcta; regenera las capturas |

En las pruebas del servidor, el caso de la llamada directa usa los valores observados
y la variante de regresión cambia solo el nivel a `partially_covered`:

- **Valores observados:** identificadores, tipos y afinidades de los 23 fragmentos, el
  vacío y el nivel.
- **Datos sustituidos:** el texto de los fragmentos y los títulos, por marcadores e
  identificadores; no se copia contenido del corpus de ForUsGuide.
- **Variante sintética:** el caso de dos vacíos distintos se conserva aparte.

Las pruebas de interfaz sustituyen la API dentro del navegador. Ninguna prueba llama a
ForUsGuide.

## Comprobación con el servidor y ForUsGuide reales

Después de las suites se comprobó el código corregido con Fastify en
`http://127.0.0.1:8798`, conectado al servicio público real de ForUsGuide, sin
sustituir la API ni las respuestas. El servidor temporal se detuvo al terminar.
Los resultados están en
[`consulta-validacion/comprobacion-real.json`](consulta-validacion/comprobacion-real.json):

- La pregunta repetida de 1036 caracteres recibió HTTP 422, `VALIDATION_ERROR`,
  motivo `larga`, con identificador `req-25b8e45c`.
- La frase simple de 100 caracteres recibió HTTP 200, `outcome: insufficient`,
  `answer: null`, sin fuentes como sustento y cobertura baja calculada por la
  política, con identificador `req-cdf1d03d`. ForUsGuide devolvió 22 fragmentos de
  11 artículos. No se presentó su texto generado como respuesta sustentada.

Es una comprobación puntual del código de trabajo con el servicio externo real;
no certifica todas sus respuestas variables ni implica un despliegue en Render.

## Capturas

En [`consulta-validacion/`](consulta-validacion/), generadas con la API sustituida:

1. `01-url-pregunta-corta.png`: URL directa con "hola".
2. `02-formulario-texto-largo-sin-recorte.png`: 150 caracteres pegados, con el
   indicador y el rechazo.
3. `03-caso-reportado-insuficiente.png`: la frase de 100 caracteres con la evidencia
   observada y el nivel `partially_covered`, como insuficiencia.
4. `04-error-http-401-forusguide.png`: un 401 real de ForUsGuide como error de
   configuración.
5. `05-movil-url-pregunta-reportada.png`: la pregunta reportada de 1036 caracteres en
   la URL, en 375 px.

## Límites pendientes

1. **El mínimo de 10 caracteres** sigue sin una decisión de negocio.
2. **Motor que declara cobertura sin otra señal.** Si ForUsGuide declara
   `partially_covered` o `well_covered` sin vacíos, y las afinidades rondan las
   observadas (media cercana a 0,32, por encima de `KD_COBERTURA_MEDIA` = 0,22), la
   política da `parcial` y la respuesta se presenta aunque admita no saber.
   - No se sabe si la llamada de Render declaró vacíos.
   - Knowledge Desk no puede detectar un motor que declara cobertura sin ninguna otra
     señal.
   - Para resolverlo de forma fiable, ForUsGuide tendría que marcar esos casos con
     `limited_coverage`, con `coverage_gaps`, con su respuesta fija de "sin
     información relevante" o con un campo explícito.
3. **El techo también afecta a respuestas válidas.** Una respuesta con `well_covered`
   y una media de las 5 mejores afinidades por debajo de 0,35, o con un solo fragmento
   relevante, se presenta ahora con Cobertura parcial en vez de alta. Los umbrales de
   kd-cobertura-v1 siguen pendientes de aprobación.
4. **Variabilidad externa.** Las comprobaciones con el servidor temporal y con la
   URL pública de Render pasaron. Una llamada no garantiza que todas las
   respuestas variables de ForUsGuide declaren correctamente sus vacíos.
5. **Credencial de ForUsGuide.** La llamada directa sin credencial respondió;
   conviene confirmar con quien opera ForUsGuide si su endpoint exige `X-API-Key`.
6. **Manual técnico.** No se modificó. Debe actualizarse con el máximo de 100 y la
   regla de cobertura.
