# Procedencia

| Campo | Valor |
| --- | --- |
| Origen | `C:\Users\ialvi\ForUsWorkspace\ForUsGuide\metodologias-agiles` |
| Repositorio | `ForUsGuide` (remoto `origin`: `https://github.com/ialvisti/ForUsGuide`) |
| Rama | `codex/tickets-production-remediation` |
| Commit HEAD | `94aa4bb273c88cc7399fca555caac00fc7bc0c0f` (2026-09-02 23:54:50 -0500, "fix(rag): stabilize PA ticket remediation responses") |
| Último commit que toca la carpeta | `4e8670cc8ad82203d2d865f843c76fa098c4d966` (2026-08-11, "docs: preserve pending project materials") |
| Fecha de extracción | 2026-10-21 |
| Método | Copia del árbol de trabajo con `robocopy`, comparada después archivo por archivo con SHA-256 |

## La copia incluye cambios locales sin commitear

- **55 de los 57 archivos no están en ningún commit.** Son todo `knowledge-desk-ui/`,
  `IMAGENES/`, la presentación, la propuesta comercial y el PDF de historias de usuario.
  La copia refleja el disco del origen el 2026-10-21.
- Los otros 2 (`Propuesta_Knowledge_Desk.docx` y
  `material-de-respaldo_version-extendida.docx`) están versionados y no difieren de HEAD.
- El contrato documentado en `docs/CONTRATO_KNOWLEDGE_QUESTION.md` describe la **copia
  de trabajo** del backend. Esa copia tiene cambios sin commitear en `api/main.py`,
  `api/config.py`, `api/auth.py`, `data_pipeline/llm_router.py` y en las pruebas, y
  en ella el endpoint exige `X-API-Key`. Cuando difiere del commit HEAD, el documento
  lo indica.

## Incluido

| Destino | Origen | Archivos |
| --- | --- | --- |
| `knowledge-desk-ui/` | `metodologias-agiles/knowledge-desk-ui/` | 36 |
| `docs/negocio/` | `metodologias-agiles/*.docx`, `*.pptx` y `*.pdf` | 5 |
| `docs/negocio/IMAGENES/` | `metodologias-agiles/IMAGENES/` | 16 |
| **Total** | | **57**, idénticos byte a byte al copiarlos |

Los documentos de negocio y las imágenes conservan su nombre y contenido originales;
solo cambia la carpeta.

## Adaptado después de copiar

| Archivo | Cambio | Motivo |
| --- | --- | --- |
| `knowledge-desk-ui/run-local.sh` | En la extracción dejó de buscar el backend en `../../kb-rag-system` y pasó a exigir `KNOWLEDGE_API_DIR`. **Se retiró en la ampliación**: la interfaz ya no habla con ForUsGuide, sino con el servidor propio, y los scripts de `scripts/` la sustituyen. | En el destino no existe `kb-rag-system`. |

## Creado en la extracción

`README.md`, `NEXT_STEPS.md`, `PROCEDENCIA.md`, `.gitignore` y
`docs/CONTRATO_KNOWLEDGE_QUESTION.md`. Los cinco se reescribieron en la ampliación.

## Excluido

| Qué | Motivo |
| --- | --- |
| `node_modules/`, `dist/`, `test-results/`, `playwright-report/` | Artefactos regenerables, ignorados por Git. |
| Archivos `.env` | Secretos. Los `.env` de ForUsGuide (raíz y `kb-rag-system/`) no se leyeron ni copiaron. El destino solo versiona `.env.example`, sin valores. |
| Historial de Git del origen | No se copió. El destino tiene su propio repositorio, cuya línea base es `de2b21a`. |
| `kb-rag-system/` (backend, scripts de ingesta, `ui/knowledge.html` heredada) | ForUsGuide sigue siendo un servicio externo. Knowledge Desk tiene ahora su propio servidor, que lo consume en modo `forusguide` (ver la ampliación). |
| Tickets, DevRev, n8n, `PA/`, `infra/` (Terraform), `endpoint-planning/`, `ticket-handler-planning/`, `tickets-development-plan/`, `docs/` del origen | Ajenos al alcance de Knowledge Desk. |
| Artículos del corpus de ForUsGuide | No se copiaron. Las pruebas y la demostración usan artículos JSON sintéticos. |

## Ampliación posterior (2026-10-21 y 2026-10-22)

Después de la extracción se implementaron HU01 a HU10 sobre **artículos de
conocimiento JSON** (kb_article_v2). Las imágenes y los PDF de `docs/negocio/` se usaron
como referencia de diseño, sin modificarlos.

| Parte | Qué es |
| --- | --- |
| `knowledge-desk-server/` | Servidor nuevo (Node 24 con TypeScript nativo y Fastify 5): consulta (`forusguide`, `local` o sin configurar), pipeline de artículos JSON (validación, fragmentación, indexación verificada, reemplazo y eliminación con fallo parcial), registro en disco, control de acceso y la interfaz compilada en el mismo origen. |
| `knowledge-desk-server/src/documents/chunker.ts` | **Port** escrito de nuevo en TypeScript del `KBChunker` de ForUsGuide (`kb-rag-system/data_pipeline/chunking.py`, leído en solo lectura). Reproduce sus formatos de texto, tipos, categorías y niveles para que los fragmentos compitan en igualdad en el índice compartido. Las diferencias deliberadas están documentadas en la cabecera del archivo. |
| Validación kb_article_v2 | Sigue los campos que exige el procesador de ForUsGuide (`article_processor.py`, leído en solo lectura) y las variantes del esquema. |
| `knowledge-desk-ui/` | Interfaz rehecha sobre la extraída: consulta conectada al servidor propio, Documentos real, visor del JSON auténtico y fuentes externas. Se retiraron la maqueta de Documentos y el cliente directo a ForUsGuide. |
| Pruebas | `node --test` en el servidor y Playwright en la interfaz (escritorio, móvil, E2E y capturas). Simuladores locales de ForUsGuide y Pinecone y artículos JSON sintéticos. Esta suite versionada (la de la CI) no llama a servicios reales. El smoke operacional contra la vista previa de Render es aparte y está en el [registro del despliegue](docs/verificacion/DEPLOY_RENDER.md). |
| Operación | `scripts/` (Windows), `.github/workflows/verificar.yml`, `render.yaml` (vista previa gratuita, desplegada) y `docs/verificacion/` (matriz de 51 criterios, capturas y [registro del despliegue](docs/verificacion/DEPLOY_RENDER.md)). |

ForUsGuide (`C:\Users\ialvi\ForUsWorkspace\ForUsGuide`) y los documentos de negocio
originales se consultaron **solo en lectura** durante toda la ampliación.

Repositorio de destino: <https://github.com/ialvisti/Knowledge-Desk.git>. La línea
base de la extracción es `de2b21a`. Los commits y envíos posteriores los gestiona el
responsable del repositorio.

## El origen no se modificó

Antes y después de la extracción se comprobaron:

- la huella del estado git del origen (`git status --porcelain --untracked-files=all`);
- la huella SHA-256 de los 57 archivos de `metodologias-agiles/`.

No se hicieron commits, `stash`, `reset` ni `checkout`, y no se instaló nada en el
origen.
