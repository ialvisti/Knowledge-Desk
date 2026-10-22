# Knowledge Desk: proyecto de Metodologías Ágiles

Knowledge Desk es una interfaz web en español para hacer preguntas a una base de
conocimiento indexada. Para cada pregunta muestra una respuesta redactada por un
modelo, sus puntos clave, las fuentes y fragmentos recuperados, y una indicación de
cobertura. Cada consulta es independiente: no hay historial, no se tocan cuentas ni
transacciones reales y nada se envía automáticamente a clientes.

Este proyecto se extrajo de `ForUsGuide/metodologias-agiles` (ver
[PROCEDENCIA.md](PROCEDENCIA.md)). Contiene la interfaz y los documentos de negocio.
El backend RAG que responde las preguntas **sigue en ForUsGuide** y aquí se trata como
un servicio externo.

## Alcance

**Incluido**

- `knowledge-desk-ui/`: aplicación React 19 + Vite 8 + Tailwind 4, con pruebas
  Playwright y lint con Oxlint.
- `docs/negocio/`: propuesta, propuesta comercial, presentación, historias de usuario
  y maquetas. Son los originales, sin modificar.
- Documentación del contrato del endpoint que consume la UI y backlog de siguientes pasos.

**No incluido: sigue en ForUsGuide**

- El backend `kb-rag-system` (FastAPI + Pinecone + OpenAI), que sirve
  `POST /api/v1/knowledge-question`.
- La ingesta y reindexación de artículos, que se hacen con scripts de ForUsGuide y no
  desde esta interfaz.
- Las credenciales del backend, la infraestructura (Terraform y Cloud Run) y todo lo
  relacionado con tickets, DevRev y n8n.

No hay un backend propio que extraer: la UI solo llama a ese endpoint, y la pantalla
Documentos es una maqueta sin backend.

## Qué es real y qué es maqueta

| Parte | Estado |
| --- | --- |
| Consulta (`/`) y Resultados (`/resultados?q=`) | **Real.** Llama a `POST /api/v1/knowledge-question` y muestra respuesta, puntos clave, cobertura, fuentes y fragmentos. |
| Validación de la pregunta (10 a 2000 caracteres) | Real; replica la regla del backend. |
| Caché de respuestas en memoria y deduplicación de envíos | Real; se pierde al recargar. |
| Documentos (`/documentos`) | **Maqueta.** Cinco documentos ficticios y carga simulada: valida PDF, DOCX o TXT de hasta 50 MB, pero no lee ni envía los archivos. |
| Sesión de usuario (icono de cuenta) | Maqueta: "Sesión de demostración. Sin cuenta conectada". |
| Autenticación | **Ninguna.** La UI no envía credenciales (ver el aviso de abajo). |

## Estructura

```text
.
├── README.md                          este archivo
├── NEXT_STEPS.md                      backlog priorizado con criterios de aceptación
├── PROCEDENCIA.md                     origen, commit e inventario incluido o excluido
├── .gitignore
├── docs/
│   ├── CONTRATO_KNOWLEDGE_QUESTION.md contrato real del endpoint y dependencias
│   └── negocio/                       documentos originales (docx, pptx, pdf)
│       └── IMAGENES/                  maquetas y capturas originales
└── knowledge-desk-ui/                 la aplicación
    ├── README.md                      README técnico original de la UI
    ├── .env.example                   variables de la UI, sin secretos
    ├── run-local.sh                   arranque conjunto con un backend local (bash)
    ├── src/
    │   ├── api/knowledgeQuestion.ts   cliente del endpoint, validación y errores
    │   ├── hooks/                     estado de la consulta
    │   ├── lib/                       adaptación de la respuesta y texto enriquecido
    │   ├── pages/                     Consulta, Resultados, Documentos y 404
    │   ├── components/  data/  state/
    │   └── index.css
    └── tests/                         Playwright, con el endpoint simulado
```

`knowledge-desk-ui/README.md` es el original. Donde dice "desde `kb-rag-system`" se
refiere a esa carpeta dentro de un checkout de ForUsGuide. Si algo no coincide, manda
este README.

## Requisitos

- Node.js 22.12 o superior. Se verificó con Node 24.14.0 y npm 11.14.0.
- Para las pruebas: Chromium de Playwright (`npx playwright install chromium`).
- Para recibir respuestas reales: un backend `kb-rag-system` de ForUsGuide accesible.
  Necesita sus propias credenciales de Pinecone y del proveedor del modelo, y cada
  consulta tiene coste.

## Instalación

```bash
cd knowledge-desk-ui
npm ci
```

## Ejecución

### Solo la interfaz

```bash
cd knowledge-desk-ui
npm run dev        # http://localhost:5173
```

Arranca sin backend. Documentos funciona entera porque es una maqueta. Al consultar
aparece "No hay conexión con la API" o un error 5xx del proxy, con un botón para
reintentar.

### Con el backend de ForUsGuide

> **Aviso sobre la autenticación.** En el commit `94aa4bb` de ForUsGuide la consulta
> general era pública y la UI funciona sin más. En la copia de trabajo actual de
> ForUsGuide (cambios locales sin commitear del 2026-10-19) el endpoint exige
> `X-API-Key`. La UI no la envía, así que cada consulta termina en
> "La API respondió con un error 401". Resolverlo es la tarea P0-1 de
> [NEXT_STEPS.md](NEXT_STEPS.md). No pongas la clave en una variable `VITE_*`:
> acabaría dentro del JavaScript que descarga el navegador.

1. Levanta el backend desde ForUsGuide:
   - **Windows (workspace local):** `.\dev.ps1 start` en la raíz de ForUsGuide. Levanta
     el backend en Docker en `127.0.0.1:8000` (ver `WORKSPACE-LOCAL.md` de ese repo).
   - **Linux, macOS o WSL:** desde `kb-rag-system`, ejecuta
     `venv/bin/python -m uvicorn api.main:app --host 127.0.0.1 --port 8000`.
2. Arranca la interfaz con `npm run dev`. El proxy de Vite reenvía `/api/*` a
   `KNOWLEDGE_API_TARGET` (por defecto `http://127.0.0.1:8000`), así que no hace falta CORS.

`run-local.sh` hace las dos cosas en bash, pero ahora necesita
`KNOWLEDGE_API_DIR=/ruta/a/ForUsGuide/kb-rag-system` y un `venv` POSIX. Sin esa
variable termina con un mensaje explicativo. Es la única adaptación de código respecto
al original.

### Verificación

```bash
cd knowledge-desk-ui
npm run build                       # tsc -b y build de producción
npm run lint                        # Oxlint
npx playwright install chromium     # una vez
npm test                            # 17 flujos × escritorio y móvil, sin backend
```

## Variables de entorno

Copia `knowledge-desk-ui/.env.example` a `knowledge-desk-ui/.env`. Ese `.env` está
ignorado por git. La UI **no necesita ningún secreto**.

| Variable | Dónde actúa | Efecto |
| --- | --- | --- |
| `KNOWLEDGE_API_TARGET` | Servidor de Vite (dev y preview) | Destino del proxy `/api`. Por defecto `http://127.0.0.1:8000`. No llega al navegador. |
| `VITE_API_BASE_URL` | Navegador (se incrusta en el build) | Llama a la API directamente, sin proxy. Requiere CORS abierto en el backend. |
| `VITE_API_TIMEOUT_MS` | Navegador | Espera máxima por respuesta. Por defecto 120000. |

Toda variable `VITE_*` es pública. No apuntes `KNOWLEDGE_API_TARGET` ni
`VITE_API_BASE_URL` a producción sin autorización: cada consulta gasta llamadas al
modelo y a Pinecone.

## Qué sigue dependiendo de ForUsGuide

| Dependencia | Detalle |
| --- | --- |
| Endpoint `POST /api/v1/knowledge-question` | Contrato en [docs/CONTRATO_KNOWLEDGE_QUESTION.md](docs/CONTRATO_KNOWLEDGE_QUESTION.md). |
| Credencial `X-API-Key` | La emite quien opera el backend (`API_CLIENT_KEYS`). Pendiente de decidir (D2). |
| Índice Pinecone y su contenido | KB de Participant Advisory de ForUsAll (401(k), mayormente en inglés). Las preguntas sugeridas de `src/data/questions.ts` se refieren a ese dominio. El comentario original de ese archivo dice que se comprobaron contra el índice real cuando se escribieron; esta extracción no llamó al servicio, así que su verificación contra el backend objetivo sigue pendiente. |
| Ingesta, actualización y borrado de artículos | Scripts de ForUsGuide (`kb-rag-system/scripts/process_single_article.py`, `update_article.py`, `delete_article.py`). No hay endpoint HTTP para eso. |
| `GET /health` | Lo usa `run-local.sh` para saber si el backend ya está en marcha. |
| Despliegue y CORS de producción | Lo controla el backend (`ENVIRONMENT`, `ALLOWED_ORIGINS`). |

## Documentos de negocio

Están en `docs/negocio/`. Hubo una revisión independiente de estos documentos; sus
conclusiones están en [NEXT_STEPS.md](NEXT_STEPS.md). Lo principal:

- **El alcance del módulo documental está en conflicto entre documentos.** La
  presentación lo sustituye por artículos JSON que cargan los técnicos. La propuesta
  comercial habla de cargar PDF y Word, pero sin pantalla administrativa para el
  cliente. Las historias HU07 a HU09 sí incluyen la pantalla Documentos. Está
  registrado como decisión pendiente (D1) y no se da por comprometido.
- Los estados y el calendario de la presentación son históricos. No acreditan el estado
  actual del proyecto.
- Las metas de calidad (≥ 85 % de aciertos, 20 de 20 consultas, latencia de 2 a 5 s)
  son objetivos por validar, no resultados medidos.

## Estado de la verificación (2026-10-21)

Comprobado en este destino con dependencias instaladas desde `package-lock.json`:

- `npm run build`: correcto.
- `npm run lint` (Oxlint 1.82.0): 0 avisos y 0 errores en 23 archivos.
- `npm test`: 34 de 34 pruebas superadas (17 en escritorio y 17 en móvil).
- `npm audit`: 2 avisos *high* heredados del lockfile original (`vite` 8.2.2 y
  `source-map-js`). Se corrigen en la tarea P1-5.

Después de verificar se borraron `node_modules`, `dist` y `test-results`. Ejecuta
`npm ci` antes de usar el proyecto.
