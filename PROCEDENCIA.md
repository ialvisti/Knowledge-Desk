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
| `knowledge-desk-ui/run-local.sh` | Ya no busca el backend en `../../kb-rag-system`, que en el destino no existe. Exige `KNOWLEDGE_API_DIR` y, si falta, termina con un mensaje. El resto del script no cambia. | Sin la adaptación, el script fallaba al arrancar con un `cd` sin explicación. |

## Creado en la extracción

`README.md`, `NEXT_STEPS.md`, `PROCEDENCIA.md`, `.gitignore` y
`docs/CONTRATO_KNOWLEDGE_QUESTION.md`.

## Excluido

| Qué | Motivo |
| --- | --- |
| `node_modules/`, `dist/`, `test-results/`, `playwright-report/` | Artefactos regenerables. No existían en el origen; los creados al verificar se borraron. |
| Archivos `.env` | Secretos. La UI no tenía `.env`. Los `.env` de ForUsGuide (raíz y `kb-rag-system/`) apuntan a credenciales privadas y no se leyeron ni copiaron. |
| `.git` | No se inicializó git en el destino. |
| `kb-rag-system/` (backend, scripts de ingesta, `ui/knowledge.html` heredada) | Se consume como servicio externo. Ver la sección "Qué sigue dependiendo de ForUsGuide" del README. |
| Tickets, DevRev, n8n, `PA/`, `infra/` (Terraform), `endpoint-planning/`, `ticket-handler-planning/`, `tickets-development-plan/`, `docs/` del origen | Ajenos al alcance de Knowledge Desk. |

## El origen no se modificó

Antes y después de la extracción se comprobaron:

- la huella del estado git del origen (`git status --porcelain --untracked-files=all`);
- la huella SHA-256 de los 57 archivos de `metodologias-agiles/`.

No se hicieron commits, `stash`, `reset` ni `checkout`, y no se instaló nada en el
origen.
