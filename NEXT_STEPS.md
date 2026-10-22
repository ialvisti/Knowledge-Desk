# Siguientes pasos

Los flujos de HU01 a HU10 están implementados y probados en local con servicios
simulados (ver la [matriz](docs/verificacion/MATRIZ_CRITERIOS.md)). La vista previa
real está desplegada (`5c1df33`) con acceso público y el servicio real de ForUsGuide.
La consulta en vivo se verificó el 2026-10-22 sobre el despliegue anterior
(`4a75c39`). Este documento recoge solo lo que falta.

Ninguna credencial se guarda en el repositorio: van en `knowledge-desk-server/.env`
(local, ignorado por Git) o en el panel del proveedor de despliegue.

## Completado en este entorno (vista previa, 2026-10-22)

- **Modo `local` (histórico, `9337e67`)**: OpenAI con `gpt-6-luna`
  (`reasoning_effort` `none`) y `text-embedding-3-small`, con corpus propio cargado
  desde Documentos.
- **Vista previa desplegada** en Render, plan gratuito y sin disco, con datos
  temporales y aviso en Documentos: <https://knowledge-desk-preview.onrender.com>.
- **Smoke básico real del modo `local`** (histórico) con un artículo sintético:
  - salud y acceso;
  - estado sin variables faltantes;
  - carga hasta Indexado;
  - consulta con fuente y JSON original byte a byte;
  - reemplazo;
  - eliminación;
  - consulta sin evidencia tras eliminar.

  Ese smoke se hizo con acceso protegido. Detalle en el
  [registro del despliegue](docs/verificacion/DEPLOY_RENDER.md).
- **No se ejercitaron en vivo**: la eliminación parcial con reintento y el rechazo
  de la credencial del proveedor. Siguen cubiertos solo por las pruebas con
  simuladores.
- **Acceso sin inicio de sesión** (decisión posterior del usuario):
  - Implementado con `KD_ACCESO_PUBLICO=true` (`4a75c39`), desplegado y verificado en
    vivo sin credenciales. `KD_ACCESO_BASICO` y `KD_OPERADORES` ya no están en el
    panel.
  - Cualquiera con la URL puede consultar, y cada consulta consume la cuota de
    ForUsGuide.
- **Consulta con el servicio real de ForUsGuide** (decisión posterior del usuario):
  - Llamada directa previa a `knowledge-question`: HTTP 200 con 4 puntos clave,
    8 artículos fuente, 15 fragmentos usados y cobertura `well_covered`.
  - **Prueba en vivo** del 2026-10-22 sobre `4a75c39`, en un navegador sin
    credenciales:
    - "Como hacer un retiro" → `answered`, modelo `gpt-5.4`, 9 fuentes,
      14 fragmentos, cobertura alta;
    - request `req-ee5c9150`, 25 030 ms;
    - fuente y Documentos abiertos, sin errores de JS.
  - **Código vigente: `5c1df33`** (`dep-dbd779ifngtc73fron20`). Incluye:
    - `render.yaml` alineado con el panel;
    - la salvaguarda contra `PINECONE_*` en la vista pública;
    - el texto de Documentos;
    - el ejemplo de retiro.

    Solo consulta: sin OpenAI ni Pinecone, no escribe en el índice compartido.
    Pruebas locales: 103 del servidor y 83 de interfaz. Detalle en el
    [registro del despliegue](docs/verificacion/DEPLOY_RENDER.md).

## 1. Corpus real aprobado

- **Modo `local`** (despliegue `9337e67`): la vista previa solo tiene el artículo
  sintético
  [`demo/articulo-sintetico-viaticos.json`](demo/articulo-sintetico-viaticos.json).
  - Negocio entrega y aprueba los artículos del corpus como JSON kb_article_v2. No se
    versionan en este repositorio si son privados.
  - Se escriben preguntas de ejemplo de ese corpus (criterio #27). Para la vista
    previa van en un archivo de `KD_EJEMPLOS_ARCHIVO`.
  - Con datos temporales, el corpus hay que volver a cargarlo cada vez que el
    servicio se suspende, se reinicia o se redespliega. Si eso no es aceptable, ver
    el paso 5.
- **Modo `forusguide`** (actual):
  - El corpus es el que ya tiene indexado ForUsGuide; Knowledge Desk no lo carga ni lo
    modifica.
  - Falta que negocio confirme que ese corpus sirve para el piloto y apruebe las
    preguntas de ejemplo de `config/ejemplos.json`.
  - Esos ejemplos se muestran sin verificar: verificarlos exige leer el índice, y la
    vista previa pública no admite credenciales de Pinecone.

**Hecho cuando**:

- en modo `local`, el corpus aprobado está Indexado y Consulta muestra sus ejemplos
  verificados;
- en modo `forusguide`, negocio aprueba el corpus y los ejemplos, y cada ejemplo se
  comprueba a mano en la vista previa.

## 2. Evaluación de calidad y latencia

Las metas de la propuesta (al menos 85 % de aciertos, 20 de 20 consultas con fuentes y
cobertura, respuestas en 2 a 5 s) **no se han medido**. Ninguna consulta suelta es
una medición:

- las dos del smoke del modo `local`, de unos 2 s;
- la de la prueba en vivo con ForUsGuide, de 25 s, por encima de la meta.

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

La vista previa usa ya el modo `forusguide`, pero **solo para consultar**. Cargar,
reemplazar o eliminar artículos en ese modo sigue condicionado.

1. **Accesos.**
   - **Disponibles y en uso**: la URL `https://forusguide.onrender.com` y una
     `X-API-Key`, verificadas en vivo. Falta confirmar si ese entorno es producción:
     si lo es, cada consulta pública de la vista previa lo carga.
   - **Pendientes**: credenciales de Pinecone con escritura sobre el índice y el
     namespace que lee ForUsGuide. Solo hacen falta para indexar desde Knowledge
     Desk, y escribir en ese índice compartido exige autorización expresa de sus
     responsables. La vista previa pública no las admite.
2. **Capacidades de ForUsGuide.** Mientras falten, los criterios #7–#10, #12, #14,
   #21, #27, #36, #39 y #44 quedan **condicionados** en ese modo. Son cambios propios
   del repositorio de ForUsGuide:

   | Capacidad en ForUsGuide | Qué resuelve |
   | --- | --- |
   | Filtro de metadatos o lista de exclusión de `article_id` en `knowledge-question` | Excluir **antes del contexto** las versiones en proceso, bloqueadas o retiradas (#10, #36, #39, #44). Hoy la respuesta se bloquea con 409 |
   | Endpoint del JSON original de un artículo | Abrir el original de los artículos externos (#21). Hoy se muestran sus fragmentos indexados, con aviso |
   | Citas por afirmación y contradicciones en la respuesta | Validar el sustento de cada afirmación (#12) y mostrar contradicciones (#14) |
   | Pruebas de su descomposición y deduplicación previas al contexto | Confirmar #8 y #9 |

3. **Prueba real de indexación en un entorno no productivo.** La consulta ya la
   cubrió la prueba en vivo del 2026-10-22. Falta el resto del recorrido, que necesita las
   credenciales de Pinecone: carga, reemplazo y eliminación (con reintento). Además, una
   `X-API-Key` rechazada debe informarse como `UPSTREAM_AUTH_ERROR`. En modo `local`,
   en cambio, una clave rechazada se informa como `RETRIEVAL_ERROR` en los embeddings
   o como `AI_PROVIDER_ERROR` en el chat.
4. **Privacidad.** Confirmar si el registro de ejecuciones de ForUsGuide
   (`ENABLE_EXECUTION_LOGGING`) guarda las preguntas y, si es así, avisarlo en la
   interfaz. Con la vista previa pública en modo `forusguide`, esto aplica a las
   preguntas de cualquiera que tenga la URL.

**Hecho cuando**: las capacidades tienen sus pruebas en ForUsGuide y Knowledge Desk
las usa, y la prueba real queda registrada sin secretos.

## 5. Producción persistente (opcional, no autorizada)

Conservar el corpus entre reinicios exige un plan de pago con disco: `KD_DATA_DIR` en
el disco y sin `KD_DATOS_TEMPORALES`. También hacen falta:

- copias de seguridad;
- la política de retención (#46);
- la decisión sobre el acceso: credenciales de piloto o proxy de identidad
  corporativo, y quiénes son operadores. El acceso público de la vista previa
  (`KD_ACCESO_PUBLICO`) no está pensado para un entorno con datos persistentes.

Con disco, Render admite una sola instancia. Solo se prepara si se aprueba el coste.

## 6. Cierre del proyecto

- Manual de usuario y manual técnico a partir del README, los contratos y el
  registro del despliegue.
- Piloto con usuarios internos sobre el corpus aprobado, con sus observaciones
  registradas.
- Acta de aceptación con el informe del paso 2, las capturas y la versión desplegada.
