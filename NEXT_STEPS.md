# Siguientes pasos

Backlog inicial de Knowledge Desk. Se basa en el código extraído, en el contrato real
del backend ([docs/CONTRATO_KNOWLEDGE_QUESTION.md](docs/CONTRATO_KNOWLEDGE_QUESTION.md))
y en las conclusiones de la revisión independiente de los documentos de `docs/negocio/`.

Leyenda: ✅ existe y está probado · 🟡 existe pero incompleto · ⏳ pendiente · ❓ decisión pendiente.

## Punto de partida

| Capacidad | Estado | Evidencia |
| --- | --- | --- |
| Consulta independiente, sin historial | ✅ | `src/pages/Consulta.tsx`, `Resultados.tsx` |
| Respuesta, puntos clave, fuentes con fragmentos y cobertura | ✅ con endpoint simulado | `tests/app.spec.ts` (17 flujos × 2 viewports) |
| Pregunta vacía, solo espacios o de menos de 10 caracteres | ✅ | prueba "inicio, validación y búsqueda por Enter" |
| Sin doble envío de la misma pregunta | ✅ | `askKnowledgeQuestion` deduplica; prueba "…no se repite la llamada" |
| Procesamiento visible y anuncio para lectores de pantalla | ✅ | pruebas "estado de carga…" y "…lector de pantalla" |
| Error con reintento, sin pintar la respuesta anterior | 🟡 | probado con 500 y con 200 + `metadata.error`; **el timeout no tiene prueba** |
| Ejemplos que siguen el mismo flujo que Buscar | ✅ | ambos navegan a `/resultados?q=`; prueba "las sugerencias consultan la API…" |
| Conexión con el backend vigente | ⏳ | la copia de trabajo de ForUsGuide exige `X-API-Key` y la UI no la envía |
| Mensajes de error con la forma real del backend | ⏳ | la UI lee `detail` y el backend responde con `message`: 401, 403, 404 y 500 pierden el texto; 503 tiene mensaje propio y 422 muestra los `msg` de `detail` |
| Pantalla Documentos | 🟡 maqueta | no hay backend; el alcance está en disputa (D1) |
| Autenticación o restricción de acceso | ⏳ | ninguna (D3) |
| Evaluación de calidad (≥ 85 %, fuera de dominio, latencia) | ⏳ | metas en los documentos, sin medir |

## Decisiones pendientes

Conviene cerrarlas antes de desarrollar. Cada una necesita responsable y fecha.

| Id | Decisión | Por qué está abierta |
| --- | --- | --- |
| D1 | ¿Entra en el alcance el módulo documental (carga, estados, reemplazo, eliminación)? | Los documentos se contradicen. `Presentacion_Knowledge_Desk.pptx` (láminas 5 y 6) lo cambia por artículos JSON que cargan los técnicos y excluye el formulario de archivos y la administración. La propuesta comercial (págs. 2 y 3) habla de cargar PDF y Word, pero niega una pantalla administrativa para el cliente. `RQ01v1…16092026_V1.pdf` (HU07 a HU09, págs. 11 a 14) incluye la pantalla Documentos (PDF, DOCX y TXT de hasta 50 MB, estados, reemplazo y eliminación). Ese PDF tiene anotaciones pendientes y el control de cambios vacío, así que ser más reciente no prueba que esté aprobado. **No se da por comprometido.** |
| D2 | ¿Qué versión del backend es la objetivo y quién emite la credencial de Knowledge Desk? | En el commit `94aa4bb` la consulta general es pública. En la copia de trabajo (sin commitear) exige `X-API-Key`. Hace falta un principal propio en `API_CLIENT_KEYS` y un responsable que lo gestione. |
| D3 | ¿Cómo se restringe el acceso interno sin crear un sistema de usuarios? | Las propuestas y la presentación excluyen la autenticación individual y los roles, pero no dicen cómo se limita el acceso. Opciones de restricción: red interna o VPN, perímetro de red, o un proxy de identidad corporativa delante del sitio. Un BFF o proxy con credencial de servicio **no es una de ellas**: protege la clave hacia el backend, pero no identifica ni filtra a quien usa la UI. Por eso debe ir siempre detrás de una de esas opciones. La restricción se aplica antes del piloto y del despliegue, sin crear usuarios propios. |
| D4 | ¿Sobre qué corpus se evalúa la solución? | El índice real es la KB de Participant Advisory de ForUsAll (401(k), mayormente en inglés) y el prompt está escrito para ese dominio. Los documentos y maquetas hablan de políticas internas (viáticos, privacidad). |
| D5 | ¿Qué se hace cuando la cobertura es baja o no hay evidencia? | Hoy se muestra la respuesta con la insignia "Cobertura limitada". La maqueta `IMAGENES/Mensaje de error en pregunta.png` propone no generar respuesta ("Documentación insuficiente"). |
| D6 | ¿Qué abre una fuente: el fragmento, el artículo completo o el documento original? | Hoy abre los fragmentos usados. La descarga o previsualización del original necesita definir el alcance y una fuente de datos que no existe. |
| D7 | ¿Cuál es el tiempo máximo de espera? | Las historias lo dejan pendiente, la meta de latencia es de 2 a 5 s y la UI corta a los 120 s por defecto. |

Fuera de alcance según los documentos (no implementar): historial de conversaciones
(HU02), cuentas o transacciones reales, envío automático de respuestas al cliente,
cuentas individuales y roles, y un backend nuevo propio de este proyecto.

## P0: bloqueantes

### P0-1. Enviar la credencial sin exponerla en el navegador ⏳

Depende de D2. Contra el backend actual de ForUsGuide, todas las consultas acaban en 401.

Criterios de aceptación:

- [ ] Con el backend que exige `X-API-Key` y `npm run dev`, las cuatro preguntas
      sugeridas devuelven 200 y se muestran.
- [ ] La clave sale de una variable de servidor **sin** prefijo `VITE_` (por ejemplo
      `KNOWLEDGE_API_KEY`) y la añade el proxy de Vite en dev y preview. En despliegue
      la añade un BFF o proxy inverso (P3-1).
- [ ] Una prueba local con un backend simulado (un servidor HTTP de prueba como
      destino del proxy, sin llamar al servicio real) comprueba que el proxy añade
      `X-API-Key` con el valor de la variable de servidor.
- [ ] Una prueba Playwright verifica que la petición del navegador no lleva
      `X-API-Key`, y buscar el valor de la clave en `dist/` no da resultados.
- [ ] `.env.example` documenta la variable sin valor y el README explica de dónde sale.
- [ ] Contra el commit `94aa4bb` (sin autenticación) la UI sigue funcionando.

### P0-2. Errores con la forma real del backend ⏳

Ante 401, 403, 404 y 500, el backend responde `{error, message, request_id}`. La UI
solo lee `detail`, así que pierde `message` y muestra un genérico
"La API respondió con un error N". El 503 sí tiene mensaje propio en el cliente ("El
servicio de conocimiento no está disponible ahora mismo."), que no depende del cuerpo.
Las fixtures de error usan `{detail}`, una forma que el backend real solo emite en 422.

Criterios de aceptación:

- [ ] El cliente lee `message` cuando es texto y sigue entendiendo `detail` (texto,
      lista de 422 u objeto con `message`).
- [ ] 401 y 403 muestran un mensaje propio de credencial ausente o inválida. 404 indica
      que el backend no sirve esa ruta (rol distinto de `producer`).
- [ ] Las fixtures reproducen la forma real; hay pruebas para 401, 403, 404, 422, 500 y 503.
- [ ] Recomendado: el aviso de error muestra el `request_id` (o `X-Request-ID`) para soporte.

### P0-3. Consolidar el alcance y las historias ⏳

Es trabajo de negocio y va antes del desarrollo funcional.

Criterios de aceptación:

- [ ] Hay una versión nueva de las historias con D1 a D7 resueltas y registradas
      (decisión, responsable, fecha).
- [ ] Están cerradas las anotaciones abiertas: HU02 ("No va porque no se guarda"),
      HU06 ("Explicar mejor") y el valor del tiempo de espera.
- [ ] El control de cambios está completo (versión, fecha, autor, aprobador).
- [ ] Hay una lista explícita de historias dentro y fuera del MVP.

## P1: integración de la consulta y trazabilidad

### P1-1. Respuestas 200 que no son respuestas ⏳

Si el modelo devuelve contenido vacío o JSON inválido, el backend responde 200 con un
texto fijo en inglés ("Unable to generate…") y **sin ninguna marca**, y la UI lo
presenta como respuesta. Cuando no se recupera ningún fragmento, devuelve un texto en
inglés con `chunks_used = 0`.

Criterios de aceptación:

- [ ] Se acuerda con quien mantiene el backend una marca explícita para esos casos (por
      ejemplo, valores nuevos de `metadata.error`). El cambio se hace en ForUsGuide, no aquí.
- [ ] La UI trata esos casos como fallo, sin pintar el texto en inglés, y hay una prueba
      por caso.
- [ ] El caso sin evidencia (`chunks_used = 0`) se presenta como decida D5 y tiene prueba.
- [ ] No se detecta permanentemente comparando textos en inglés. Si se usa como
      solución temporal, queda marcada y probada.

### P1-2. Cobertura explicable 🟡

Criterios de aceptación:

- [ ] Negocio valida la fórmula y los umbrales de `_calculate_knowledge_confidence`
      (documentados en el contrato).
- [ ] La UI explica qué significa cada nivel y deja claro que **no es una probabilidad
      de que la respuesta sea correcta**.
- [ ] Hay pruebas para alta, parcial, limitada, valor desconocido y sin evidencia. Hoy
      solo se prueban alta y limitada.
- [ ] Queda documentado que las fuentes salen de los fragmentos usados y que la UI
      oculta los fragmentos operativos (`guardrails` cuenta para la cobertura aunque no
      se muestre).

### P1-3. Trazabilidad entre historias, código y pruebas 🟡

Criterios de aceptación:

- [ ] Existe una matriz `docs/TRAZABILIDAD.md` que une cada criterio de HU01, HU03,
      HU04, HU05, HU06 y HU10 con un archivo y una prueba (la tabla "Punto de partida"
      sirve de base).
- [ ] Hay una prueba de tiempo agotado con un `VITE_API_TIMEOUT_MS` corto. Debe mostrar
      el aviso, ofrecer reintentar y no pintar ninguna respuesta anterior.
- [ ] Hay una prueba de doble clic en Buscar durante la carga que deja una sola llamada.

### P1-4. Prueba de contrato contra un backend no productivo ⏳

Criterios de aceptación:

- [ ] Un script opt-in (por ejemplo `npm run test:contract`) solo se ejecuta si se
      definen la URL y la clave de un entorno local o de staging. Nunca corre por
      defecto ni en CI, y nunca contra producción.
- [ ] Comprueba que una respuesta real cumple los tipos de
      `src/api/knowledgeQuestion.ts` y que un 401 real tiene la forma documentada.
- [ ] Registra la latencia y guarda el resultado como evidencia, sin datos personales.

### P1-5. Dependencias con avisos *high* ⏳

`npm audit` informa de `vite` 8.2.2 (avisos del servidor de desarrollo, entre ellos
ejecución de scripts entre orígenes) y de `source-map-js`. Vienen heredados del
lockfile original.

Criterios de aceptación:

- [ ] `npm audit --audit-level=high` no devuelve hallazgos.
- [ ] `npm run build`, `npm run lint` y `npm test` siguen en verde.
- [ ] La actualización del lockfile va en un cambio aparte.

## P2: calidad y alcance funcional

### P2-1. Evaluación de calidad ⏳

Las metas de `Propuesta_Knowledge_Desk.docx` (§3.1 a §3.4, y criterios C1 a C5 del §5) y
de `material-de-respaldo_version-extendida.docx` (§7.8) **están por validar**.

Criterios de aceptación:

- [ ] Hay una batería versionada y acordada con negocio sobre el corpus de D4:
      pregunta, criterio de respuesta correcta y fuentes esperadas, con casos fuera de
      dominio.
- [ ] Está escrita la definición de "acierto".
- [ ] La ejecución es reproducible contra un entorno autorizado y produce un informe con
      el porcentaje de aciertos (meta ≥ 85 %), 20 de 20 consultas con fuentes y
      cobertura, el resultado en preguntas fuera de dominio y la latencia p50 y p95
      (meta de 2 a 5 s).

### P2-2. Módulo documental ❓ (solo si D1 lo aprueba)

Hoy no hay ningún endpoint HTTP de carga, reemplazo o borrado. La ingesta se hace con
scripts de ForUsGuide sobre artículos JSON, y `/api/v1/chunks` lista fragmentos, no
documentos.

- Si D1 lo excluye:
  - [ ] Se retira la pantalla Documentos o se marca como fuera de alcance, y se ajustan
        el README y las pruebas.
- Si D1 lo incluye:
  - [ ] Los endpoints necesarios se definen y construyen en el backend, como alcance
        aparte en ForUsGuide.
  - [ ] Primera entrega de solo lectura: lista real con nombre, fecha, número de
        fragmentos y estado.
  - [ ] Después, HU07 a HU09: formatos y límite, estados, reemplazo y eliminación con
        fallo parcial (maquetas en `docs/negocio/IMAGENES/`).

### P2-3. Abrir una fuente 🟡 (depende de D6)

- [ ] Se mantiene el diálogo de fragmentos (✅ ya existe).
- [ ] Si se aprueba, se añade un enlace al artículo completo o a una vista previa del
      original, con su fuente de datos definida en el backend.

### P2-4. Restricción de acceso interno ⏳ (depende de D3)

Debe estar aplicada antes del piloto y de cualquier despliegue (P3). El BFF o proxy de
P0-1 y P3-1 protege la credencial, pero no sustituye esta restricción.

- [ ] El mecanismo elegido (red interna, VPN, perímetro o identidad corporativa) está
      documentado y aplicado en el entorno de piloto.
- [ ] Hay una prueba que demuestra que desde fuera del perímetro autorizado no se
      accede a la UI ni al endpoint a través de ella.
- [ ] No se crean cuentas ni roles propios.

## P3: despliegue, piloto y aceptación

### P3-1. Despliegue ⏳

- [ ] El build estático se sirve con reescritura de rutas a `index.html`.
- [ ] `/api` se sirve en el mismo origen mediante un BFF o proxy inverso que añade la
      credencial (P0-1). Todo el sitio queda detrás de la restricción de acceso de P2-4.
- [ ] CORS del backend limitado al origen real (`ALLOWED_ORIGINS`) o innecesario.
- [ ] Las variables están separadas por entorno y no hay URLs de producción en el código.
- [ ] Hay un *smoke* posterior al despliegue con una sola consulta autorizada.

### P3-2. Integración continua ⏳

- [ ] El pipeline ejecuta `npm ci`, build, lint, `npm test` con Chromium y `npm audit`.
- [ ] Las pruebas también pasan por el typecheck: hoy `tests/` no está en ningún
      `tsconfig` (la comprobación manual pasó sin errores).

### P3-3. Piloto, manuales y evidencia de aceptación ⏳

Corresponde al criterio C5: backend y UI desplegados y documentados.

- [ ] Manual de usuario y manual técnico (arranque, variables, dependencia del backend,
      operación).
- [ ] Piloto con usuarios internos y sus observaciones registradas.
- [ ] Acta de aceptación con evidencias: informe de P2-1, capturas y versión desplegada.

### P3-4. Privacidad ⏳

- [ ] La UI avisa de que no se deben escribir datos personales en la pregunta.
- [ ] Se confirma con quien opera el backend el valor de `ENABLE_EXECUTION_LOGGING`,
      que guarda pregunta y respuesta, y su retención.

## Orden recomendado

1. P0-3 y las decisiones D1 a D7: consolidar alcance e historias.
2. P0-1 y P0-2: integración con el backend vigente.
3. P1-1 a P1-4: trazabilidad, cobertura y contrato. P1-5 en paralelo.
4. P2-1: evaluación (≥ 85 %, fuera de dominio, latencia). P2-2 a P2-4 según lo decidido.
5. P3: despliegue, piloto, manuales y evidencia de aceptación.

Los estados y el calendario de la presentación (agosto a 21 de octubre de 2026) son
históricos y no acreditan el avance real. Este backlog parte del código verificado el
2026-10-21.
