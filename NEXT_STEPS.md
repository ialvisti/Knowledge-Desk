# Siguientes pasos

Los flujos de HU01 a HU10 están implementados y probados en local con servicios
simulados (ver la [matriz](docs/verificacion/MATRIZ_CRITERIOS.md)). La vista previa
real ya está desplegada. Este documento recoge solo lo que falta.

Ninguna credencial se guarda en el repositorio: van en `knowledge-desk-server/.env`
(local, ignorado por Git) o en el panel del proveedor de despliegue.

## Completado en este entorno (vista previa, 2026-10-22)

- **Modo `local` configurado**: OpenAI con `gpt-6-luna` (`reasoning_effort` `none`)
  y `text-embedding-3-small`, con corpus propio cargado desde Documentos.
- **Vista previa desplegada** en Render, plan gratuito y sin disco, con datos
  temporales y aviso en Documentos: <https://knowledge-desk-preview.onrender.com>.
- **Smoke básico real** con un artículo sintético:
  - salud y acceso;
  - estado sin variables faltantes;
  - carga hasta Indexado;
  - consulta con fuente y JSON original byte a byte;
  - reemplazo;
  - eliminación;
  - consulta sin evidencia tras eliminar.

  Detalle en el [registro del despliegue](docs/verificacion/DEPLOY_RENDER.md).
- **No se ejercitaron en vivo**: la eliminación parcial con reintento y el rechazo
  de la credencial del proveedor. Siguen cubiertos solo por las pruebas con
  simuladores.

## 1. Corpus real aprobado

La vista previa solo tiene el artículo sintético
[`demo/articulo-sintetico-viaticos.json`](demo/articulo-sintetico-viaticos.json).

- Negocio entrega y aprueba los artículos del corpus como JSON kb_article_v2. No se
  versionan en este repositorio si son privados.
- Se escriben preguntas de ejemplo de ese corpus (criterio #27). Para la vista previa
  van en un archivo de `KD_EJEMPLOS_ARCHIVO`.
- Con datos temporales, el corpus hay que volver a cargarlo cada vez que el servicio
  se suspende, se reinicia o se redespliega. Si eso no es aceptable, ver el paso 5.

**Hecho cuando**: el corpus aprobado está Indexado y la pantalla Consulta muestra sus
ejemplos verificados.

## 2. Evaluación de calidad y latencia

Las metas de la propuesta (al menos 85 % de aciertos, 20 de 20 consultas con fuentes y
cobertura, respuestas en 2 a 5 s) **no se han medido**. Las dos consultas del smoke
(unos 2 s) no son una medición.

- Negocio aprueba una muestra versionada sobre el corpus del paso 1:
  - pregunta;
  - criterio de respuesta correcta;
  - fuentes esperadas;
  - casos fuera de dominio y casos sin evidencia.
- Se ejecuta contra la vista previa (o el entorno que se decida). La latencia se mide
  con el servicio despierto y el primer acceso tras la suspensión se registra aparte.
- El informe recoge:
  - porcentaje de aciertos;
  - consultas con fuentes y cobertura;
  - comportamiento fuera de dominio;
  - latencia p50 y p95.

**Hecho cuando**: el informe está acordado y, si hace falta, los umbrales de cobertura
(paso 3) se ajustan con esos datos.

## 3. Aceptación de negocio de las propuestas configurables

Cinco reglas están implementadas como propuestas, aún **no aceptadas** por negocio.
Cada una se cambia por configuración o en un único módulo:

| Criterio | Propuesta implementada | Dónde se cambia |
| --- | --- | --- |
| #4 | Tiempo máximo de 30 a 120 s (90 s por defecto) | `KD_CONSULTA_TIMEOUT_MS` |
| #22 | Política `kd-cobertura-v1`: relevancia ≥ 0,20, media ≥ 0,35 para alta y ≥ 0,22 para parcial | `KD_COBERTURA_*`, `src/consulta/coverage.ts` |
| #33 | Clasificación por tipo y nivel heredada del chunker de ForUsGuide | `src/documents/chunker.ts` |
| #39 | Sustitución total al reemplazar | `src/documents/pipeline.ts` |
| #46 | Los originales retirados se archivan en `KD_DATA_DIR/archivo-retirados` sin plazo de borrado | Política de retención por definir |

**Hecho cuando**: cada propuesta está aceptada o ajustada, y la decisión queda
registrada.

## 4. Integración con ForUsGuide (condicionada)

Solo hace falta si se quiere el modo `forusguide`, es decir, el corpus y el motor de
ForUsGuide. La vista previa no lo usa.

1. **Accesos.** Quien opera ForUsGuide debe dar:
   - La URL de un entorno **no productivo**. Su README apunta a
     `https://forusguide.onrender.com/docs`; hay que confirmar si es producción.
   - Una `X-API-Key` propia para Knowledge Desk.
   - Credenciales de Pinecone con escritura sobre el índice y el namespace que lee
     ForUsGuide. Escribir en ese índice compartido exige autorización expresa de sus
     responsables.
2. **Capacidades de ForUsGuide.** Mientras falten, los criterios #7–#10, #12, #14,
   #21, #27, #36, #39 y #44 quedan **condicionados** en ese modo. Son cambios propios
   del repositorio de ForUsGuide:

   | Capacidad en ForUsGuide | Qué resuelve |
   | --- | --- |
   | Filtro de metadatos o lista de exclusión de `article_id` en `knowledge-question` | Excluir **antes del contexto** las versiones en proceso, bloqueadas o retiradas (#10, #36, #39, #44). Hoy la respuesta se bloquea con 409 |
   | Endpoint del JSON original de un artículo | Abrir el original de los artículos externos (#21). Hoy se muestran sus fragmentos indexados, con aviso |
   | Citas por afirmación y contradicciones en la respuesta | Validar el sustento de cada afirmación (#12) y mostrar contradicciones (#14) |
   | Pruebas de su descomposición y deduplicación previas al contexto | Confirmar #8 y #9 |

3. **Prueba real en un entorno no productivo.** El mismo recorrido que el smoke de la
   vista previa: carga, consulta, reemplazo y eliminación (con reintento). Además, una
   `X-API-Key` rechazada debe informarse como `UPSTREAM_AUTH_ERROR`. En modo `local`,
   en cambio, una clave rechazada se informa como `RETRIEVAL_ERROR` en los embeddings
   o como `AI_PROVIDER_ERROR` en el chat.
4. **Privacidad.** Confirmar si el registro de ejecuciones de ForUsGuide
   (`ENABLE_EXECUTION_LOGGING`) guarda las preguntas y, si es así, avisarlo en la
   interfaz.

**Hecho cuando**: las capacidades tienen sus pruebas en ForUsGuide y Knowledge Desk
las usa, y la prueba real queda registrada sin secretos.

## 5. Producción persistente (opcional, no autorizada)

Conservar el corpus entre reinicios exige un plan de pago con disco: `KD_DATA_DIR` en
el disco y sin `KD_DATOS_TEMPORALES`. También hacen falta:

- copias de seguridad;
- la política de retención (#46);
- la decisión sobre el acceso: credenciales de piloto o proxy de identidad
  corporativo, y quiénes son operadores.

Con disco, Render admite una sola instancia. Solo se prepara si se aprueba el coste.

## 6. Cierre del proyecto

- Manual de usuario y manual técnico a partir del README, los contratos y el
  registro del despliegue.
- Piloto con usuarios internos sobre el corpus aprobado, con sus observaciones
  registradas.
- Acta de aceptación con el informe del paso 2, las capturas y la versión desplegada.
