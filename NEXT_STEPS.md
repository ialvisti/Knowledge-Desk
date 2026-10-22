# Siguientes pasos

Lo que falta para usar Knowledge Desk con servicios reales y aceptarlo. Los flujos de
HU01 a HU10 ya están implementados y probados en local con servicios simulados (ver
la [matriz](docs/verificacion/MATRIZ_CRITERIOS.md)) y no se repiten aquí.

Cada paso indica quién lo resuelve y cuándo se da por cerrado. Ningún paso exige
guardar credenciales en el repositorio: van en `knowledge-desk-server/.env` (local,
ignorado por Git) o en el panel del proveedor de despliegue.

## 1. Configurar el corpus y el proveedor

Hay que decidir el modo y conseguir sus accesos.

**Opción A: `KD_MODO=forusguide`**, con el corpus y el motor de ForUsGuide.

- Pedir a quien opera ForUsGuide:
  - La URL de un entorno **no productivo**. El README de ForUsGuide apunta a
    `https://forusguide.onrender.com/docs`; hay que confirmar si es producción antes de
    usarlo.
  - Una `X-API-Key` propia para Knowledge Desk (un principal en su `API_CLIENT_KEYS`).
- Credenciales de Pinecone con escritura sobre el índice y el namespace que lee
  ForUsGuide. Cargar, reemplazar o eliminar artículos escribe en ese índice
  compartido, así que sus responsables tienen que autorizarlo de forma expresa.

**Opción B: `KD_MODO=local`**, con un corpus propio. Elegir el proveedor
(OpenAI-compatible), los modelos de embeddings y de chat y el presupuesto. Los
artículos se cargan desde Documentos.

En los dos casos, el corpus aprobado se carga como artículos JSON kb_article_v2 y
`config/ejemplos.json` se reescribe con preguntas de ese corpus (criterio 27).

**Hecho cuando**: `GET /api/estado` devuelve `consulta.configurada: true`,
`indexacion.configurada: true` y `faltan: []`, y la pantalla Consulta muestra
ejemplos verificados.

## 2. Capacidades de ForUsGuide (solo para la opción A)

En modo `forusguide`, Knowledge Desk no ve el contexto antes de que ForUsGuide
responda. Los criterios #7–#10, #12, #14, #21, #27, #36, #39 y #44 quedan
**condicionados** hasta que ForUsGuide ofrezca lo siguiente, como cambio propio en su
repositorio (aquí se trata en solo lectura):

| Capacidad en ForUsGuide | Qué resuelve |
| --- | --- |
| Filtro de metadatos o lista de exclusión de `article_id` en `knowledge-question` | Excluir **antes del contexto** las versiones en proceso, bloqueadas o retiradas (#10, #36, #39, #44). Hoy la respuesta se bloquea con 409 |
| Endpoint del JSON original de un artículo | Abrir el original de los artículos externos (#21). Hoy se muestran sus fragmentos indexados, con aviso |
| Citas por afirmación y contradicciones en la respuesta | Validar el sustento de cada afirmación (#12) y mostrar contradicciones (#14) |
| Pruebas de su descomposición y deduplicación previas al contexto | Confirmar #8 y #9 |

**Hecho cuando**: cada capacidad tiene su prueba en ForUsGuide y Knowledge Desk
la usa, con una prueba contra el simulador actualizado.

## 3. Integración real en un entorno no productivo

Hay que ejecutar, con las credenciales del paso 1 y fuera del repositorio, una
comprobación manual u opt-in:

1. Comprobar `/api/estado`.
2. Cargar un artículo JSON sintético y esperar a que pase a Indexado, con los vectores
   visibles en el índice.
3. Hacer una consulta que lo cite y abrir su JSON desde la fuente.
4. Reemplazarlo y comprobar que la consulta usa solo la versión nueva.
5. Eliminarlo, incluido un reintento.
6. Provocar un error de credencial y comprobar que se informa como
   `UPSTREAM_AUTH_ERROR`.

**Hecho cuando**: hay un registro de la ejecución (fecha, entorno, IDs de solicitud
y resultados) sin secretos ni datos personales, y cualquier diferencia con los
simuladores se corrige con una prueba.

## 4. Evaluación de calidad y latencia

Las metas de la propuesta (al menos 85 % de aciertos, 20 de 20 consultas con fuentes y
cobertura, respuestas en 2 a 5 s) **no se han medido**.

- Negocio aprueba una muestra versionada sobre el corpus del paso 1:
  - pregunta;
  - criterio de respuesta correcta;
  - fuentes esperadas;
  - casos fuera de dominio y casos sin evidencia.
- Se ejecuta contra el entorno del paso 3.
- El informe recoge:
  - porcentaje de aciertos;
  - consultas con fuentes y cobertura;
  - comportamiento fuera de dominio;
  - latencia p50 y p95.

**Hecho cuando**: el informe está acordado y los umbrales de cobertura (paso 6) se
ajustan con esos datos, si hace falta.

## 5. Decisiones de despliegue

`render.yaml` está preparado, pero no se ha creado nada. Antes de crear el Blueprint
hay que decidir:

- **Coste**: plan Starter con disco de 1 GB (≈ 7,25 USD/mes según el precio publicado
  por Render el 2026-10-22).
- **Acceso**: credenciales de piloto (`KD_ACCESO_BASICO`) o proxy de identidad
  corporativo, y quiénes son operadores (`KD_OPERADORES`).
- **Datos**: copias de seguridad del disco y retención de los originales retirados.
  Con disco hay una sola instancia y una breve interrupción en cada despliegue.

**Hecho cuando**:

- El Blueprint está creado con las variables del paso 1 en el panel (`sync: false`).
- El *smoke* posterior pasa: `/api/salud`, `/api/estado` y una consulta autorizada.
- `autoDeploy` sigue en `false` salvo que se decida lo contrario.

## 6. Aprobaciones de negocio pendientes

Están implementadas como propuestas y se cambian por configuración o en un único
módulo:

| Criterio | Propuesta implementada | Dónde se cambia |
| --- | --- | --- |
| #4 | Tiempo máximo de 30 a 120 s (90 s por defecto) | `KD_CONSULTA_TIMEOUT_MS` |
| #22 | Política `kd-cobertura-v1`: relevancia ≥ 0,20, media ≥ 0,35 para alta y ≥ 0,22 para parcial | `KD_COBERTURA_*`, `src/consulta/coverage.ts` |
| #33 | Clasificación por tipo y nivel heredada del chunker de ForUsGuide | `src/documents/chunker.ts` |
| #39 | Sustitución total al reemplazar | `src/documents/pipeline.ts` |
| #46 | Los originales retirados se archivan en `KD_DATA_DIR/archivo-retirados` sin plazo de borrado | Política de retención por definir |

También hay que confirmar con quien opera ForUsGuide si su registro de ejecuciones
(`ENABLE_EXECUTION_LOGGING`) guarda las preguntas, y avisarlo en la interfaz si es así.

## 7. Cierre del proyecto

- Manual de usuario y manual técnico a partir del README y de los contratos.
- Piloto con usuarios internos, con sus observaciones registradas.
- Acta de aceptación con el informe del paso 4, las capturas y la versión desplegada.
