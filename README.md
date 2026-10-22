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
- **Vista previa real** en <https://knowledge-desk-preview.onrender.com> (Render
  gratuito, datos temporales).
  - Primer despliegue (`9337e67`): modo `local` con OpenAI y acceso protegido. Su
    smoke real con un artículo **sintético** pasó (carga, consulta con fuente, JSON
    original byte a byte, reemplazo, eliminación y consulta sin evidencia).
  - **Actual** (`5c1df33`): acceso sin inicio de sesión y consultas con el **servicio
    real de ForUsGuide**, solo consulta y sin credenciales de Pinecone. La consulta en
    vivo sin credenciales se verificó el 2026-10-22 sobre el despliegue anterior
    (`4a75c39`).
  - Detalle en el [registro del despliegue](docs/verificacion/DEPLOY_RENDER.md).
- **Pendiente** (ver [NEXT_STEPS.md](NEXT_STEPS.md)):
  - evaluación de calidad y latencia con una muestra validada;
  - aceptación de negocio de cinco propuestas configurables;
  - capacidades de ForUsGuide que condicionan su modo;
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

Resultados del 2026-10-22:

- **Local, código actual** (`5c1df33`):
  - servidor: 103 pruebas;
  - interfaz: 83 pruebas de navegador y E2E;
  - tipos y lint correctos. El build y `npm audit` no se repitieron en local.
- **CI de `5c1df33`**: estado en la
  [run `39850199650`](https://github.com/ialvisti/Knowledge-Desk/actions/runs/39850199650).
- **CI de `4a75c39`** (histórica,
  [run `39835813660`](https://github.com/ialvisti/Knowledge-Desk/actions/runs/39835813660)):
  98 pruebas del servidor, 81 de interfaz y E2E, build, tipos, lint y auditorías, en
  verde.

La suite de pruebas versionada (la de la CI) usa artículos JSON sintéticos y
simuladores locales, y no llama a servicios reales. No hay corpus privado en el
repositorio.

Aparte de esa suite hay dos pruebas **operacionales reales**, separadas de las
cifras anteriores. El [registro del despliegue](docs/verificacion/DEPLOY_RENDER.md)
detalla qué acredita cada una y qué no:

- el smoke del modo `local` (histórico) con un artículo sintético;
- la prueba en vivo con ForUsGuide, sin login.

## Vista previa gratuita en Render

<https://knowledge-desk-preview.onrender.com>. El
[registro del despliegue](docs/verificacion/DEPLOY_RENDER.md) recoge el servicio, los
commits, las pruebas reales y las restricciones.

Por decisión del usuario:

1. **Sin inicio de sesión** (`KD_ACCESO_PUBLICO=true`): se entra directamente.
2. **Motor de consulta: el servicio real de ForUsGuide** (`KD_MODO=forusguide`,
   `POST https://forusguide.onrender.com/api/v1/knowledge-question`). Las respuestas y
   las fuentes salen del corpus de ForUsGuide, no del artículo sintético local.

Despliegues y prueba en vivo:

- **Actual**: `dep-dbd779ifngtc73fron20`, commit `5c1df33`. El blueprint y el panel
  coinciden.
- **Prueba en vivo del 2026-10-22**, sobre el despliegue anterior
  (`dep-dbd5qu3l550s73apj9gg`, commit `4a75c39`), en un navegador nuevo sin
  credenciales:
  - "Como hacer un retiro" → `answered`, `engine: forusguide`, modelo `gpt-5.4`,
    9 fuentes, 14 fragmentos, cobertura alta.
  - Request `req-ee5c9150`, 25 030 ms.
  - Se abrió una fuente y Documentos; ningún error de JS y ninguna cabecera
    `Authorization`.

[`render.yaml`](render.yaml) describe el web service **gratuito y sin disco**:

- Compila la interfaz y arranca `node knowledge-desk-server/src/main.ts`, con salud en
  `/api/salud` y `autoDeploy: false`.
- Fija `KD_MODO=forusguide` y `FORUSGUIDE_API_URL=https://forusguide.onrender.com`.
  La `X-API-Key` (`FORUSGUIDE_API_KEY`, `sync: false`) solo va en el panel de Render.
- **Solo consulta.** No declara `PINECONE_API_KEY` ni `PINECONE_INDEX_HOST`, así que
  Knowledge Desk no tiene indexación y nunca escribe, siembra ni borra en el índice
  compartido de ForUsGuide. Con el acceso público, el servidor se niega a arrancar si
  aparecen.
  - Documentos lo dice ("Las consultas usan el corpus de ForUsGuide…") y no permite
    cargar.
  - `/api/estado` devuelve `indexacion.configurada: false` y lista esas dos variables
    en `faltan`, a propósito.
- **Fuentes externas**: ForUsGuide no expone el JSON original de sus artículos. Al
  abrir una fuente se muestran sus fragmentos indexados (`/api/v1/chunks`), con el
  aviso de que no son el original.
- **Ejemplos**: los de la lista `forusguide` de `config/ejemplos.json` (valor por
  defecto), empezando por "¿Cómo hago un retiro de mi 401(k)?". Sin acceso de lectura
  al índice no se verifican antes de mostrarse.
- `KD_ACCESO_PUBLICO=true`, `KD_DATA_DIR=/tmp/knowledge-desk` con
  `KD_DATOS_TEMPORALES=true` y `KD_MAX_ARTICULO_MB=10`. En el panel solo se rellenan
  `FORUSGUIDE_API_KEY` y, opcionalmente, `KD_CONTACTO_URL`. No existen
  `KD_ACCESO_BASICO`, `KD_IDENTIDAD_HEADER`, `KD_PROXY_SECRETO`, `KD_OPERADORES`,
  `PINECONE_API_KEY` ni `PINECONE_INDEX_HOST`.
- Cada consulta llama a ForUsGuide con la clave del servidor y consume su cuota.
- **Límites**:
  - La calidad (≥ 85 %, 20 de 20) no se ha medido.
  - La única consulta en vivo tardó 25 s, por encima de la meta de 2 a 5 s.

**Vista previa anterior (histórico).** El despliegue `9337e67` usaba el modo `local`
con OpenAI, acceso protegido y el artículo sintético
[`demo/articulo-sintetico-viaticos.json`](demo/articulo-sintetico-viaticos.json), que
se cargaba en Documentos. Su smoke real está en el registro. El artículo sigue sirviendo
para probar el modo `local`.

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
  sesión (`KD_ACCESO_PUBLICO=true`) y consulta el servicio real de ForUsGuide, sin
  escribir en su índice.
- Un reemplazo es del mismo `article_id`. La eliminación exige confirmación y se
  reintenta si es parcial.
- La vista previa es **gratuita** en Render, con datos temporales y sin cómputo ni
  disco de pago. El primer despliegue usó el modo `local` con OpenAI. El actual
  consulta ForUsGuide, que consume la cuota de ese servicio.

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
