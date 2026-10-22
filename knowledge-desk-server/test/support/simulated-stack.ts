import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { construirApp, construirServicios } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { documentosDemo } from './demo-documentos.ts'
import { multipart } from './entorno.ts'
import { iniciarForUsGuideSimulado } from './forusguide-simulado.ts'
import { iniciarPineconeSimulado } from './pinecone-simulado.ts'

// MODO SIMULADO — solo pruebas y demostración explícita.
// Levanta el servidor REAL de Knowledge Desk en modo forusguide, pero apuntado a
// simuladores locales de ForUsGuide y Pinecone. Nada sale a Internet y ningún
// resultado de este modo acredita una integración real.
//
// Opciones:
//   --sembrar     carga los artículos demo por la API real (estados reales del pipeline)
//   --documentos  escribe los artículos JSON demo en demo/documentos y termina
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const argumentos = new Set(process.argv.slice(2))

if (argumentos.has('--documentos')) {
  const destino = path.join(raiz, 'demo', 'documentos')
  await mkdir(destino, { recursive: true })
  for (const [nombre, contenido] of Object.entries(documentosDemo())) await writeFile(path.join(destino, nombre), contenido)
  console.log(`Artículos JSON demo escritos en ${destino}`)
  process.exit(0)
}

const puerto = Number(process.env.KD_SIM_PORT ?? 8788)
const dataDir = path.join(raiz, 'data-simulado', String(puerto))
// El índice simulado vive en memoria: el registro se reinicia con él para que
// ambos sigan siendo coherentes.
await rm(dataDir, { recursive: true, force: true })

const pinecone = await iniciarPineconeSimulado(Number(process.env.KD_SIM_PINECONE_PORT ?? 8790))
const forusguide = await iniciarForUsGuideSimulado({ pinecone, apiKey: 'clave-simulada-forusguide', puerto: Number(process.env.KD_SIM_FORUSGUIDE_PORT ?? 8791) })
const config = loadConfig({
  KD_MODO: 'forusguide',
  KD_HOST: '127.0.0.1',
  KD_PORT: String(puerto),
  FORUSGUIDE_API_URL: forusguide.url,
  FORUSGUIDE_API_KEY: 'clave-simulada-forusguide',
  PINECONE_API_KEY: 'clave-simulada-pinecone',
  PINECONE_INDEX_HOST: pinecone.url,
  PINECONE_NAMESPACE: 'kb_simulado',
  KD_DATA_DIR: dataDir,
  KD_EJEMPLOS_ARCHIVO: path.join(raiz, 'demo', 'ejemplos-simulados.json'),
  KD_VERIFICACION_INDICE_MS: process.env.KD_VERIFICACION_INDICE_MS ?? '30000',
  KD_VERIFICACION_INTERVALO_MS: '200',
  KD_CONSULTA_TIMEOUT_MS: process.env.KD_CONSULTA_TIMEOUT_MS ?? '30000',
  KD_CONTACTO_URL: 'mailto:area.responsable@empresa.invalid',
  // La interfaz marca de forma visible que las respuestas son simuladas.
  KD_DEMO_SIMULADO: 'true',
  ...(process.env.KD_UI_DIST ? { KD_UI_DIST: process.env.KD_UI_DIST } : {}),
})
const servicios = await construirServicios(config, { pineconeMaxRetries: 0 })
const app = await construirApp(servicios, { logger: false })
await app.listen({ host: config.host, port: config.port })

if (argumentos.has('--sembrar')) {
  const archivos = documentosDemo()
  for (const nombre of ['Política_Privacidad_2023.json', 'Manual_Operaciones_V2.json', 'Guia_Estilo_Archivistica.json', 'Reporte_Financiero_Q3.json', 'Borrador_Incompleto.json', 'Politica_Viaticos_v3.2.json', 'Manual_Gastos.json']) {
    await app.inject({ method: 'POST', url: '/api/documentos', ...multipart(nombre, archivos[nombre]) })
    await servicios.gestor.esperarInactividad()
  }
}

console.log([
  '',
  '  MODO SIMULADO — servicios externos simulados (no es una integración real)',
  `  Knowledge Desk:        http://127.0.0.1:${puerto}${config.uiDistDir ? '' : '  (sin interfaz compilada: usa npm run dev en knowledge-desk-ui)'}`,
  `  ForUsGuide simulado:   ${forusguide.url}   (POST /__control para inyectar fallos)`,
  `  Pinecone simulado:     ${pinecone.url}   (POST /__control para inyectar fallos)`,
  `  Datos aislados en:     ${dataDir}`,
  '',
].join('\n'))

async function apagar() {
  await app.close()
  await forusguide.cerrar()
  await pinecone.cerrar()
  process.exit(0)
}
process.on('SIGINT', apagar)
process.on('SIGTERM', apagar)
