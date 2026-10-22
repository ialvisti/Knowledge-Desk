import { construirApp, construirServicios } from './app.ts'
import { ConfigError, capacidades, loadConfig } from './config.ts'

let config
try {
  config = loadConfig()
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`Configuración no válida: ${error.message}`)
    process.exit(2)
  }
  throw error
}

const servicios = await construirServicios(config)
const app = await construirApp(servicios)
const puede = capacidades(config)
const detenerLimpieza = servicios.gestor.iniciarLimpiezaPeriodica(5 * 60_000)

await app.listen({ host: config.host, port: config.port })
app.log.info({
  modo: config.modo,
  consulta: puede.consulta ? 'configurada' : 'NO configurada',
  indexacion: puede.indexacion ? 'configurada' : 'NO configurada',
  faltan: puede.faltan,
  acceso: config.accesoBasico.length ? 'credenciales de piloto' : config.identityHeader ? 'proxy de identidad' : 'solo localhost',
  datos: config.dataDir,
  interfaz: config.uiDistDir ? 'servida desde dist' : 'no compilada (usa npm run dev en knowledge-desk-ui)',
}, 'Knowledge Desk en marcha')

async function apagar() {
  detenerLimpieza()
  await app.close()
  await servicios.gestor.esperarInactividad()
  process.exit(0)
}
process.on('SIGINT', apagar)
process.on('SIGTERM', apagar)
