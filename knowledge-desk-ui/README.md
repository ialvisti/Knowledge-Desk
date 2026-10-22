# Knowledge Desk

Interfaz en español para consultar el conocimiento indexado. Las pantallas siguen el
**Knowledge Desk Design System** de Google Stitch (proyecto `14550129711982413133`).

La consulta está conectada al backend RAG: la pregunta viaja a
`POST /api/v1/knowledge-question` y la pantalla muestra la respuesta redactada por el
modelo, sus puntos clave, la cobertura declarada y los fragmentos que se recuperaron
del índice.

## Ejecutar

Requiere Node.js 22.12 o superior y el backend RAG en marcha.

Con un solo comando, que levanta el backend y la interfaz:

```bash
./run-local.sh
```

O en dos terminales, si prefieres controlarlos por separado:

```bash
# 1) backend, desde kb-rag-system
FORUSBOTS_MAX_WAIT_S=240 venv/bin/python -m uvicorn api.main:app --host 127.0.0.1 --port 8000

# 2) interfaz, desde este directorio
npm ci
npm run dev
```

Abre la dirección que muestre Vite, normalmente http://localhost:5173.

```bash
npm run build    # TypeScript y compilación de producción
npm run preview  # Vista previa de dist
npm run lint     # Análisis estático con Oxlint
```

### Conexión con la API

Las peticiones salen relativas (`/api/v1/knowledge-question`) y el servidor de
desarrollo de Vite las reenvía al backend, así que el navegador nunca cruza de origen
y no hace falta configurar CORS. Copia `.env.example` a `.env` para ajustarlo:

| Variable | Efecto |
| --- | --- |
| `KNOWLEDGE_API_TARGET` | Destino del proxy de Vite. Por defecto `http://127.0.0.1:8000`. |
| `VITE_API_BASE_URL` | Llama a la API directamente desde el navegador, sin proxy. Exige CORS abierto en el backend. |
| `VITE_API_TIMEOUT_MS` | Espera máxima por respuesta. Por defecto 120000. |

`run-local.sh` arranca el backend con `FORUSBOTS_MAX_WAIT_S=240`. El `.env` local de
`kb-rag-system` deja ese valor igual al presupuesto de inquiry y la validación de
arranque lo rechaza; el ajuste sólo afecta al manejo de tickets, que esta interfaz no
usa.

## Pantallas

| Ruta | Función |
| --- | --- |
| `/` | Consulta con buscador y cuatro preguntas sugeridas. |
| `/resultados?q=...` | Respuesta del backend, puntos clave y fuentes con sus fragmentos. |
| `/documentos` | Filtrado por nombre y carga simulada. Sigue siendo una maqueta. |

La pregunta permanece en la URL, así que recargar o compartir el enlace repite la
consulta. Una pregunta con menos de 10 caracteres se rechaza en la interfaz, que es el
mínimo que exige la API.

## Comportamiento de la consulta

- Mientras el backend responde se muestra un indicador de carga. Una consulta real
  tarda unos segundos: recupera fragmentos del índice y el modelo redacta la respuesta.
- La misma pregunta no se envía dos veces seguidas. La respuesta se guarda en memoria
  durante la sesión, así que volver atrás la muestra al instante. Se pierde al recargar.
- Los fallos de red, los tiempos agotados y los errores de la API se explican en
  pantalla con un botón para reintentar. El backend atrapa sus propios fallos y los
  devuelve con estado 200 y `metadata.error`; ese caso también se trata como fallo en
  lugar de pintarse como respuesta.
- El texto del modelo llega con marcas ligeras de markdown y casi nunca deja una línea
  en blanco entre el encabezado y su lista, así que se interpreta línea a línea:
  encabezados, párrafos, negritas y listas anidadas.
- La insignia de cobertura refleja el campo `confidence_note` que devuelve el backend:
  alta, parcial o limitada.
- Cada ficha de fuente abre los fragmentos que el índice recuperó para ese artículo,
  con su afinidad. Los bloques operativos de los artículos, que sólo consumen los
  procesos internos, no se muestran en la consulta.

## Alcance de la demostración

- La pantalla Documentos no está conectada: valida el formato por la extensión, acepta
  PDF, DOCX y TXT no vacíos hasta 50 MiB, y no lee ni envía los archivos. Los
  documentos añadidos pasan de "Procesando · demo" a "Indexado · demo" tras 1,5
  segundos y no alimentan las respuestas. La ingesta real ocurre fuera de la interfaz.
- No hay autenticación, historial de conversación ni persistencia entre recargas.
- Las fuentes Inter, Newsreader y los iconos Material Symbols se sirven desde los
  paquetes locales, sin peticiones a Google Fonts.

## Organización

- `src/api`: cliente del endpoint, validación de la pregunta y control de errores.
- `src/hooks`: estado de la consulta (inactiva, cargando, resuelta, fallida).
- `src/lib`: interpretación del texto del modelo y adaptación de la respuesta a la vista.
- `src/pages`: Consulta, Resultados, Documentos y página 404.
- `src/components`: navegación, búsqueda, controles y fuentes documentales.
- `src/data`: preguntas sugeridas y datos de la pantalla Documentos.
- `src/index.css`: tokens de Tailwind, estilos compartidos y adaptación a móvil.

El tema mantiene el papel `#F7F6F2`, las superficies `#FAF9F5`, el texto `#1B1C1A`, el
verde principal `#115341` y el acento `#2F6B58`. Newsreader se usa para títulos e Inter
para controles y texto.

## Pruebas

```bash
npx playwright install chromium
npm test
```

Playwright inicia Vite automáticamente si el puerto 5173 está libre y ejecuta los
flujos en escritorio (1280 × 1024) y móvil (375 × 812). Las pruebas interceptan
`/api/v1/knowledge-question` y responden con una copia recortada de una respuesta real,
así que no dependen del backend ni gastan llamadas al modelo. Cubren la búsqueda, la
validación del mínimo, el indicador de carga, el reuso de la respuesta en memoria, el
fallo con reintento, la cobertura limitada, el diálogo de fragmentos, la maqueta de
documentos, el fallo interno con estado 200, el anuncio para lectores de pantalla, la
conservación de las listas del modelo, la navegación por teclado y el desbordamiento del
viewport.

Para servir el build desde un alojamiento estático, configura la reescritura de rutas a
`index.html` para admitir los enlaces directos de React Router, y define
`VITE_API_BASE_URL` en el build o sirve la API bajo el mismo origen.
