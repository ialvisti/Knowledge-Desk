# Cobertura baja con evidencia fuerte en modo directo (2026-11-04)

La pregunta "¿Cómo hago un retiro de mi 401(k)?" mostraba **Cobertura baja**, "5 de 5
fragmentos relevantes · 3 documentos" y bloqueaba la respuesta. Antes, con el modo
`forusguide`, se mostraba con Cobertura alta. La evidencia saneada está en
[COBERTURA_DIRECTO_2026-11-04.json](COBERTURA_DIRECTO_2026-11-04.json).

## Entorno del diagnóstico

- Modo `directo`, el de la vista previa de Render. Índice compartido: coseno, 1024
  dimensiones, `llama-text-embed-v2`. Namespace `kb_articles`, solo búsqueda.
- Modelo `gpt-5.5`, el mismo que usa ForUsGuide para la descomposición y para
  knowledge-question.
- Política `kd-cobertura-v1` con los umbrales sin cambios: 0,20, 0,22 y 0,35.
- Para los diagnósticos se usó un script local de solo lectura que llama al código del
  repositorio. No se escribió, listó ni borró nada en Pinecone. No se imprimieron
  claves, host ni texto del corpus.

## Causa

1. **El prompt de redacción no definía qué es un vacío.** La política cuenta cada
   vacío como una parte de la pregunta que el corpus no cubre: con 2 o más, `baja`.
   - En modo `forusguide`, los vacíos los declaraba ForUsGuide con un prompt que los
     acota. Sus reglas 2, 8 y 9 (`SYSTEM_PROMPT_KNOWLEDGE_QUESTION`) piden tratar cada
     concepto y declarar solo lo central que falta, no detalles ni temas secundarios.
   - En modo `directo`, los declara `PROMPT_SISTEMA` de Knowledge Desk, que no los
     definía. `gpt-5.5` listaba como vacíos los pasos de hardship o de préstamo (no
     preguntados), la situación laboral o el plan de quien pregunta, pantallas paso a
     paso o plazos exactos.
   - Línea base v0: de 6 ejecuciones sobre retiros, 4 quedaron bloqueadas, todas por
     2 o 3 vacíos de ese tipo. La media de las 5 mejores afinidades del contexto estaba
     entre 0,585 y 0,634.
2. **La explicación mentía.** Sin nivel del motor, un `baja` causado por vacíos
   mostraba "La documentación disponible apenas toca tu consulta", aunque las
   afinidades fueran de 0,56 a 0,65.
3. **Había un desajuste secundario entre el prompt y el validador de citas.** El
   validador exige una cita en cada oración y viñeta (`unidadesAfirmativas`), pero el
   prompt solo pedía citar "cada afirmación".
   - Con los vacíos ya corregidos, 3 de 25 respuestas sustentadas se descartaron por
     una frase introductoria sin cita, por ejemplo: "How you withdraw money depends on
     whether you are still employed and on your plan's rules."
   - Antes este fallo quedaba oculto, porque los vacíos ya bajaban el nivel a `baja`.

**Descartado:**

- Escala de puntuaciones, top-k, diversidad y metadata. El índice, el modelo de
  embeddings, el topK de 15, el presupuesto (16 000 caracteres, unos 4000 tokens), el
  máximo de 6 fragmentos por artículo y los tipos prioritarios coinciden con
  knowledge-question.
- Las afinidades relevantes rondan 0,55–0,70.
- Con la misma evidencia, el cálculo de ForUsGuide habría dado `partially_covered` o
  `limited_coverage` por los mismos vacíos.

## Captura

La primera ejecución v0 reprodujo la captura exactamente: `insufficient`, `baja`, 5 de 5,
3 documentos y la explicación genérica, con 2 vacíos.

El resultado es estocástico. Las otras dos ejecuciones v0 de la misma pregunta dieron:

- 6 de 6 y `baja`, con 3 vacíos;
- 5 de 5 y `parcial`, con 1 vacío.

## Cambios

- `knowledge-desk-server/src/consulta/local.ts`, `PROMPT_SISTEMA`, compartido por los
  modos local y directo:
  - **Regla 2:** cita en cada oración y viñeta, incluidas las introductorias.
  - **Regla 6:** cada objetivo pedido se evalúa por separado. El tema general no cubre
    los demás objetivos. Un plazo, formulario, requisito o excepción **pedido
    expresamente** que falte es un vacío. Si la pregunta no lo pide, no lo es. Tampoco
    lo son los detalles, por ejemplo el paso a paso de cada variante ante una pregunta
    general, ni los temas secundarios.
  - **Regla 7:** si faltan datos de quien pregunta para aplicar una regla documentada,
    no se inventan ni se confirma la elegibilidad. Se explican la condición y el dato
    necesario, y eso no cuenta como vacío.
  - **Regla 8:** `[]` solo si ningún objetivo pedido queda sin respaldo.
- `knowledge-desk-server/src/consulta/coverage.ts`: un `baja` con vacíos declarados usa
  la explicación de vacíos también sin nivel del motor.
- `knowledge-desk-server/test/directo.test.ts`: 3 pruebas del contrato con
  fragmentos sintéticos de afinidad 0,60. Usan como salidas fijas del modelo la
  `respuesta` y los `vacios_de_cobertura` exactos de s1, s2 y s3 en v5 (ver el JSON).
  - **s1:** respuesta general sustentada, sin vacíos. Resultado: `answered`, `alta`,
    una fuente con 2 fragmentos.
  - **s2:** formulario y plazo pedidos pero ausentes. Resultado: `insufficient`,
    `baja`, y la explicación indica los vacíos.
  - **s3:** respuesta condicional con citas contiguas `[1][2]`. Resultado: `answered`,
    `alta`.

**Sin cambios:**

- umbrales y reglas de `kd-cobertura-v1`;
- validación de citas;
- filtrado de versiones no servibles;
- namespaces;
- contrato de respuesta.

## Validación real con el modelo

| Versión | Pregunta principal | Variante EN | Negativo (vacaciones) | s1 inicio | s2 formulario + plazo | s3 retiro en servicio |
| --- | --- | --- | --- | --- | --- | --- |
| v0 (HEAD) | 1 de 3 respondida (parcial); 2 `baja` por vacíos | `baja` (3 vacíos) | `baja` | — | — | — |
| v2 | — | — | — | `alta`, `[]` | `baja`, 2 vacíos | `parcial`: 1 vacío por datos personales |
| v3 | 1 de 2 (`alta`); 1 `baja` (3 vacíos no pedidos) | `alta` | `baja` | `alta` | `baja`, 2 vacíos | `alta` ×2, condicional |
| v4 | 2 de 3 (`alta`, `parcial`); 1 `baja` | `alta` | `baja` | `alta` | `baja`, 2 vacíos | `alta`, condicional |
| **v5 (final)** | **3 de 3 `alta`, 0 vacíos** | **`alta`** | **`baja`** (1 vacío real, sin respuesta) | **`alta`, `[]`** | **`baja`, 2 vacíos reales** | **`alta`, `[]`, solo condicional** |

- s1, s2 y s3 usan dos fragmentos sintéticos de afinidad 0,60:
  - s1 y s2: "La solicitud de retiro se inicia desde el portal" y "En el portal, abre
    Retiros y selecciona Iniciar solicitud";
  - s3: "retiro en servicio requiere al menos 60 años" y "El plan debe habilitar esa
    modalidad".
- Respuesta v5 de s3: "Para poder hacer un retiro en servicio de tu 401(k), en este
  ejemplo necesitas tener al menos 60 años y que el plan habilite esa modalidad. No puedo
  confirmar si tú puedes hacerlo sin saber tu edad y si tu plan habilita el retiro en
  servicio."
- v3–v5 reutilizan la descomposición y las búsquedas reales capturadas en v3 (3
  descomposiciones, 6 búsquedas). Solo se repite la redacción, y el código de
  recuperación no cambió.
- La versión intermedia v1 la descartó la auditoría porque silenciaba vacíos genuinos.
  Con ella: 0 vacíos en 25 ejecuciones positivas, 3 descartadas por una frase sin cita
  y los negativos bloqueados. También se ejecutaron hardship, rollover, RMD y
  force-out, todas en `alta`.

## Pruebas automáticas

Hay dos tipos de validación:

- **La CI (`npm test`) fija el contrato con salidas del modelo ya observadas.** Comprueba
  qué hace Knowledge Desk con ellas: cobertura, explicación, citas, fuentes y bloqueo.
  No demuestra el cambio de comportamiento del modelo, porque no lo llama.
- **El cambio semántico del prompt** solo lo valida la evaluación con el modelo real de
  la sección anterior.

| Comando (en `knowledge-desk-server`) | Resultado |
| --- | --- |
| `npm run typecheck` | Sin errores |
| `npm run lint` | Sin errores |
| `npm test` | 197 de 197 |
| `npm run build`, desde la raíz (`tsc -b` + `vite build` de la interfaz) | Correcto |

Contra el código de `fa12f16`, de las 3 pruebas nuevas solo debe fallar la de s2. Allí
la explicación era "apenas toca tu consulta" en lugar de mencionar los vacíos. Las de s1
y s3 fijan comportamiento que ya existía. Ese contraste se razonó con el diff y no se
volvió a ejecutar tras ajustar las pruebas.

El build de la interfaz pasó; no se ejecutaron sus pruebas de navegador porque la interfaz no cambió.

## Límites

- **El modelo no es determinista.** v5 acertó 8 de 8, pero la muestra es pequeña: 3
  ejecuciones de la pregunta principal sobre una misma recuperación. No garantiza
  todas las ejecuciones.
- **Render sigue con el prompt anterior** hasta un despliegue, que no se hizo.
- **No probado en el diagnóstico:**
  - el namespace `knowledge_desk_documents`;
  - el modo local con un modelo real, aunque comparte el prompt.
- **El contrato no expone los vacíos;** solo la explicación los resume.
- **ForUsGuide en local:** su copia local canoniza las consultas
  (`sanitize_retrieval_query`). No se replicó, porque la recuperación ya es buena, y
  no se verificó si está en producción.
