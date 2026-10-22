# Knowledge Desk

Asistente de conocimiento interno (RAG) en español:

- **Colaboradores internos**: hacen preguntas en lenguaje natural y reciben una
  respuesta sustentada, sus puntos clave, las fuentes usadas y un indicador de
  cobertura. Si la evidencia no basta, no se genera respuesta.
- **Operadores técnicos**: administran el corpus, formado **solo por artículos de
  conocimiento JSON** con esquema kb_article_v2 (`metadata` + `details`). Los cargan,
  reemplazan, eliminan e inspeccionan.

Cada consulta es independiente: no hay historial, no se tocan cuentas ni
transacciones y nada se envía a clientes.

## Estado (2026-10-22)

- **Cobertura completa en local, con servicios simulados**: HU01 a HU10. La
  [matriz de los 51 criterios](docs/verificacion/MATRIZ_CRITERIOS.md) da el estado de
  cada criterio por modo y no oculta condiciones. La suite de pruebas versionada,
  la misma que ejecuta la CI, no llama a servicios reales.
- **Vista previa real desplegada** en <https://knowledge-desk-preview.onrender.com>:
  Render gratuito, modo `local` con OpenAI y datos temporales.
  - El smoke real con un artículo **sintético** pasó: carga, consulta con fuente, JSON
    original byte a byte, reemplazo, eliminación y consulta sin evidencia tras
    eliminar.
  - Detalle y restricciones en el
    [registro del despliegue](docs/verificacion/DEPLOY_RENDER.md).
- **Pendiente** (ver [NEXT_STEPS.md](NEXT_STEPS.md)):
  - corpus real aprobado;
  - evaluación de calidad y latencia con una muestra validada;
  - aceptación de negocio de cinco propuestas configurables;
  - integración real con ForUsGuide y Pinecone (modo `forusguide`, condicionada);
  - persistencia (opcional, no autorizada).

## Cómo funciona

```text
Navegador ── mismo origen ──▶ Servidor de Knowledge Desk (Node 24 + Fastify)
 (React)                       │  API /api/*, interfaz compilada, acceso, registro en disco
                               │
                               ├─ modo forusguide ─▶ ForUsGuide POST /api/v1/knowledge-question (X-API-Key)
                               │                     + Pinecone, mismo índice y namespace
                               └─ modo local ──────▶ proveedor OpenAI-compatible (embeddings y chat)
                                                     + índice vectorial propio en KD_DATA_DIR
```

- El navegador solo habla con el servidor de Knowledge Desk. Las credenciales viven
  en variables del servidor: ninguna variable `VITE_*`, nada en el navegador ni en el
  repositorio.
- **Artículos JSON**: se validan contra kb_article_v2, con la ruta exacta de cada error.
  Se guardan byte a byte con su SHA-256 y se fragmentan con un port del chunker de
  ForUsGuide (mismos tipos, categorías y niveles), con las rutas JSON de origen de
  cada fragmento. Solo se publican cuando el índice confirma todos los vectores. El
  visor muestra el JSON auténtico de la versión que sustentó una respuesta, con las
  rutas usadas resaltadas. Detalle en
  [docs/CONTRATO_KNOWLEDGE_QUESTION.md](docs/CONTRATO_KNOWLEDGE_QUESTION.md).
- **Reemplazo**: debe ser el mismo `article_id`. La versión vigente sirve hasta que la
  nueva queda verificada.
- **Eliminación**: confirmada y con conteos medidos. Si es parcial, el documento queda
  bloqueado y se puede reintentar.

| Modo (`KD_MODO`) | Consulta | Artículos JSON | Para qué |
| --- | --- | --- | --- |
| `forusguide` | ForUsGuide recupera, arma el contexto y redacta. Knowledge Desk valida, aplica la cobertura y bloquea respuestas con versiones no servibles | Se indexan en el **mismo** índice y namespace de Pinecone que lee ForUsGuide | Usar el corpus y el motor de ForUsGuide |
| `local` | Todo el flujo en Knowledge Desk: búsqueda semántica, subpreguntas, deduplicación previa, contexto solo con versiones servibles y validación de citas | Índice propio en disco | Corpus propio con cualquier proveedor OpenAI-compatible |
| sin valor | `INTEGRATION_NOT_CONFIGURED`: nunca inventa respuestas | No se indexa | Arranque sin configuración |
| simulado (`scripts\simulado.ps1`) | Servidor real contra simuladores locales de ForUsGuide y Pinecone. La interfaz avisa "Modo demostración" | Pipeline real contra el índice simulado | Demostración y pruebas, sin Internet |

Las diferencias de garantías entre `forusguide` y `local` están en la matriz:
filtrado previo del contexto, JSON original de artículos externos, citas y
contradicciones.

## Requisitos

- Windows 10 u 11 con PowerShell 5.1 o 7.
- Node.js 22.18 o superior. Se probó con **24.14.0** (`.node-version`).
- Acceso al registro de npm para instalar. Chromium de Playwright para las pruebas: lo
  instala `scripts\instalar.ps1`.

## Inicio rápido en Windows (modo demostración)

Desde la carpeta del proyecto, en PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\instalar.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\simulado.ps1
```

Abre <http://127.0.0.1:5173>. El stack simulado carga por la API real unos artículos
JSON sintéticos (los genera en `demo/documentos/`, que no se versiona). Puedes cargar
los tuyos en **Documentos**. `Ctrl+C` detiene la interfaz y el stack que el script
inició. Con `-SinSembrar` arranca con el corpus vacío.

Cada script se detiene en el primer comando que falle, con su código de salida. Los
procesos en segundo plano corren en la misma consola y al terminar se detiene solo el
árbol de procesos que inició el script.

## Con servicios reales

1. Crea la configuración local (ignorada por Git) y complétala solo en tu equipo:
   `Copy-Item knowledge-desk-server\.env.example knowledge-desk-server\.env`.
2. Elige un modo:
   - `KD_MODO=forusguide`: rellena `FORUSGUIDE_API_URL` y `FORUSGUIDE_API_KEY` (la
     `X-API-Key` que emite quien opera ForUsGuide), y `PINECONE_API_KEY`,
     `PINECONE_INDEX_HOST` y `PINECONE_NAMESPACE` (el que lee ForUsGuide; por defecto
     `kb_articles`). Cargar, reemplazar o eliminar **escribe en ese índice
     compartido**: requiere autorización de sus responsables.
   - `KD_MODO=local`: rellena `KD_LLM_BASE_URL` (por ejemplo `https://api.openai.com/v1`
     o un Ollama local), `KD_LLM_API_KEY`, `KD_EMBEDDINGS_MODEL` y `KD_CHAT_MODEL`.
3. Arranca:
   - Desarrollo: `scripts\iniciar.ps1` levanta el servidor y Vite en
     <http://127.0.0.1:5173>.
   - Mismo origen: `scripts\iniciar.ps1 -Produccion` compila la interfaz y la sirve
     el servidor en <http://127.0.0.1:8787>.
4. `GET /api/estado` muestra el modo y la lista `faltan` de variables requeridas, sin
   valores.

Cada consulta, carga o reemplazo con servicios reales consume llamadas al modelo y al
índice, y tiene coste.

### Acceso

- Por defecto el servidor escucha en `127.0.0.1` y, si no se configuran
  credenciales de piloto ni proxy de identidad, no exige credencial. Si se configuran,
  se exigen también en localhost.
- Fuera de localhost, el servidor **no arranca** sin una de estas opciones:
  - `KD_ACCESO_BASICO`: credenciales de piloto, `usuario:clave` con claves de 12
    caracteres o más, sobre HTTPS.
  - Un proxy de identidad corporativo: `KD_IDENTIDAD_HEADER` + `KD_PROXY_SECRETO`.
  - `KD_ACCESO_PUBLICO=true`: acceso directo sin inicio de sesión, solo para una vista
    previa pública decidida de forma explícita.
    - Cualquiera con la URL consulta y carga, reemplaza o elimina artículos.
    - Las operaciones se registran como "Acceso público".
    - No se combina con las dos opciones anteriores ni con `KD_OPERADORES`: si se
      mezclan, el servidor no arranca.
- `KD_OPERADORES` limita quién administra los artículos (solo con acceso controlado).
- `/api/salud` es pública y no expone datos.

## Verificación

| Comando | Qué ejecuta |
| --- | --- |
| `scripts\verificar.ps1` | Servidor: typecheck, lint, pruebas y `npm audit`. Interfaz: build, lint, `npm audit` y Playwright (escritorio, móvil y E2E contra el stack simulado). |
| `npm run verificar` (raíz) | Lo mismo sin las auditorías. Es lo que ejecuta la CI (`.github/workflows/verificar.yml`, Node 24.14, Chromium, sin secretos). |
| `scripts\capturas.ps1` | Regenera las 23 capturas de `docs/verificacion/` contra el stack simulado y [`comparacion.html`](docs/verificacion/comparacion.html). `-SoloComparacion` solo regenera la página. |

Resultado local del 2026-10-22, con el acceso público incluido:

- Servidor: 98 pruebas.
- Interfaz: 81 pruebas de navegador y E2E.
- Tipos, lint y build correctos.
- `npm audit`: 0 vulnerabilidades en el servidor y en la interfaz.

La suite de pruebas versionada (la de la CI) usa artículos JSON sintéticos y
simuladores locales, y no llama a servicios reales. No hay corpus privado en el
repositorio.

Aparte de esa suite, se hizo un smoke **operacional real**, también con Playwright,
contra la vista previa desplegada en Render y con un artículo sintético. El
[registro del despliegue](docs/verificacion/DEPLOY_RENDER.md) detalla qué acredita y
qué no, y registra la CI en verde del commit desplegado.

## Vista previa gratuita en Render (desplegada)

<https://knowledge-desk-preview.onrender.com>. El
[registro del despliegue](docs/verificacion/DEPLOY_RENDER.md) recoge el servicio, el
commit desplegado, el smoke real y las restricciones.

**Acceso sin inicio de sesión.** Después del primer smoke, que se hizo con acceso
protegido, el usuario decidió quitar el login de esta vista previa. `render.yaml` fija
`KD_ACCESO_PUBLICO=true`, de modo que, al desplegar este cambio, se entra
directamente: cualquiera con la URL consulta y administra artículos, y cada uso
consume la cuota de OpenAI. El resultado de ese despliegue se registrará en el
registro cuando se verifique.

**Probarla con el artículo sintético**

1. Descarga [`demo/articulo-sintetico-viaticos.json`](demo/articulo-sintetico-viaticos.json)
   (datos ficticios).
2. En **Documentos**, carga el JSON con **Explorar archivos** y espera a que quede
   **Indexado**.
3. Pregunta en **Consulta**, por ejemplo: "¿En qué plazo se solicita el reembolso de
   viáticos internacionales después del viaje?".

Si Documentos aparece vacío, el servicio se suspendió o se reinició y perdió los datos:
vuelve a cargar el archivo. Nada se carga solo.

[`render.yaml`](render.yaml) describe ese único web service **gratuito y sin disco**:

- Compila la interfaz y arranca `node knowledge-desk-server/src/main.ts`, con salud en
  `/api/salud` y `autoDeploy: false`.
- Fija `KD_MODO=local` (corpus propio cargado desde Documentos) y
  `KD_LLM_BASE_URL=https://api.openai.com/v1`.
- Fija los modelos `KD_EMBEDDINGS_MODEL=text-embedding-3-small` y
  `KD_CHAT_MODEL=gpt-6-luna`, con `KD_CHAT_REASONING_EFFORT=none`, que ese modelo
  necesita para aceptar `temperature` 0.
- Fija `KD_ACCESO_PUBLICO=true` (sin inicio de sesión).
- En el panel de Render (`sync: false`, sin valores en el repositorio) se rellena
  `KD_LLM_API_KEY` y, opcionalmente, `KD_CONTACTO_URL`.
- En el panel **no** deben quedar `KD_ACCESO_BASICO`, `KD_IDENTIDAD_HEADER`,
  `KD_PROXY_SECRETO` ni `KD_OPERADORES`: con el acceso público, el servidor no
  arrancaría.
- **Datos temporales**:
  - `KD_DATA_DIR=/tmp/knowledge-desk` está en el sistema de archivos efímero de la
    instancia gratuita. Los artículos cargados, el registro y el índice local se
    pierden al reiniciar, al redesplegar o cuando el servicio se suspende por
    inactividad.
  - `KD_DATOS_TEMPORALES=true` hace que el pie de Documentos lo avise.
  - Esta marca no cambia el modo ni presenta el servicio como simulado: el proveedor
    es real y cada carga y consulta consume su cuota.
- `KD_MAX_ARTICULO_MB=10`, por la memoria de la instancia gratuita.
- `KD_EJEMPLOS_ARCHIVO=demo/ejemplos-preview.json`: tres preguntas sobre el contenido
  del artículo **sintético** de viáticos (`demo/articulo-sintetico-viaticos.json`),
  que no es una política real.
  - Solo se muestran mientras un artículo las sustenta: con el corpus vacío o tras un
    reinicio se ocultan.
  - Nada se carga solo al arrancar, porque gastaría cuota del proveedor en cada
    reinicio.

La persistencia (plan de pago con disco) es un paso futuro opcional, **no
autorizado**. Ver [NEXT_STEPS.md](NEXT_STEPS.md).

## Decisiones

**Tomadas e implementadas**

- El corpus son solo artículos JSON canónicos kb_article_v2. PDF, DOCX y TXT no se
  aceptan. Los PDF de `docs/negocio/IMAGENES` son solo referencia de diseño.
- "Abrir el documento" muestra el JSON auténtico de la versión usada.
- Interfaz y API en el mismo origen. Credenciales solo en el servidor. Acceso interno
  sin cuentas propias: credenciales de piloto o proxy de identidad.
- Excepción decidida por el usuario: la vista previa de Render no tiene inicio de
  sesión (`KD_ACCESO_PUBLICO=true`).
- Un reemplazo es del mismo `article_id`. La eliminación exige confirmación y se
  reintenta si es parcial.
- El primer despliegue es una vista previa **gratuita** en Render, con datos
  temporales y modo `local`. Está desplegada. No hay cómputo ni disco de pago; el
  uso del modelo consume la API de OpenAI.

**Propuestas implementadas, pendientes de aprobación de negocio** (detalle en
[NEXT_STEPS.md](NEXT_STEPS.md)):

- Tiempo máximo de 30 a 120 s (90 s por defecto).
- Política de cobertura `kd-cobertura-v1` y sus umbrales.
- Clasificación de fragmentos heredada de ForUsGuide.
- Sustitución total al reemplazar.
- Retención de los originales retirados.

## Estructura

```text
.
├── README.md · NEXT_STEPS.md · PROCEDENCIA.md · render.yaml · package.json · .node-version
├── .github/workflows/verificar.yml      CI sin secretos
├── config/ejemplos.json                 preguntas de ejemplo por modo (HU06)
├── demo/
│   ├── ejemplos-simulados.json          ejemplos del modo demostración
│   ├── ejemplos-preview.json            ejemplos de la vista previa de Render
│   └── articulo-sintetico-viaticos.json artículo JSON ficticio para cargar en la vista previa
├── scripts/                             instalar, simulado, iniciar, verificar, capturas (+ comun.ps1)
├── docs/
│   ├── CONTRATO_KNOWLEDGE_QUESTION.md   contratos: consulta, artículos JSON y ForUsGuide
│   ├── verificacion/                    matriz de 51 criterios, registro del despliegue, 23 capturas, comparacion.html
│   └── negocio/                         documentos y referencias de diseño originales (no se editan)
├── knowledge-desk-server/               API, pipeline de artículos JSON, acceso y pruebas (node --test)
└── knowledge-desk-ui/                   interfaz React y pruebas Playwright (ver su README)
```

## Procedencia y Git

El proyecto se extrajo de `ForUsGuide/metodologias-agiles` y después se amplió. El
detalle está en [PROCEDENCIA.md](PROCEDENCIA.md). ForUsGuide y los documentos de
negocio se consultaron solo en lectura.

- Repositorio: <https://github.com/ialvisti/Knowledge-Desk.git>.
- Línea base de la extracción: `de2b21a`.
- El historial, los envíos y el despliegue los gestiona el responsable del repositorio.
