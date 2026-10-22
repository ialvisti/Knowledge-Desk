import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Catálogo único de las capturas finales y de su referencia en
// docs/negocio/IMAGENES. El spec de capturas toma de aquí la referencia y la nota,
// y comparacion.html se genera solo a partir de este catálogo.
// Ejecutable por sí solo (sin volver a capturar): node tests/capturas/comparacion.ts

export interface Captura { archivo: string; referencia: string | null; nota: string }

export const CAPTURAS: Captura[] = [
  { archivo: '01-consulta.png', referencia: 'Consulta — Knowledge Desk.pdf', nota: 'Pantalla inicial con ejemplos verificados contra el corpus y el aviso de modo demostración.' },
  { archivo: '02-resultados.png', referencia: 'Resultados — Knowledge Desk.pdf', nota: 'Respuesta sustentada: cobertura, puntos clave y fuentes con su ruta JSON.' },
  { archivo: '03-insuficiencia-cobertura-baja.png', referencia: 'Mensaje de error en pregunta.png', nota: 'Cobertura baja real: no se genera respuesta.' },
  { archivo: '04-sin-evidencia.png', referencia: 'Mensaje de error en pregunta.png', nota: 'Sin evidencia: sin documentos que ver ni referencias inventadas.' },
  { archivo: '05-error-validacion.png', referencia: 'Consumir los servicios de consulta 2.png', nota: 'Validación real del servidor (422) con ID de soporte y contrato JSON.' },
  { archivo: '06-error-recuperacion.png', referencia: 'Consumir los servicios de consulta 3.png', nota: 'Fallo "retrieval" inyectado en el servicio de consulta simulado.' },
  { archivo: '07-error-base-vectorial.png', referencia: 'Consumir los servicios de consulta 4.png', nota: 'Fallo "vector" inyectado en el servicio de consulta simulado.' },
  { archivo: '08-error-proveedor.png', referencia: 'Consumir los servicios de consulta 5.png', nota: 'Fallo "proveedor" inyectado en el servicio de consulta simulado.' },
  { archivo: '09-error-tiempo-agotado.png', referencia: null, nota: 'Tiempo máximo del servidor (30 s) agotado: TIMEOUT sin respuesta parcial.' },
  { archivo: '10-documentos.png', referencia: 'Vista de documentos.png', nota: 'Lista real: Indexado, Procesando (reintento esperando al índice) y Error (sin contenido indexable).' },
  { archivo: '11-documentos-motivo-error.png', referencia: null, nota: 'Motivo real del Error de Borrador_Incompleto.json: sin contenido indexable.' },
  { archivo: '12-reemplazo-dialogo.png', referencia: 'Vista de edicion de documento.png', nota: 'Diálogo de reemplazo con el título canónico del artículo y su versión activa.' },
  { archivo: '13-reemplazo-exito.png', referencia: 'Mensaje de exito de reemplazo de documento.png', nota: 'Reemplazo verificado: la nueva versión ya está activa.' },
  { archivo: '14-reemplazo-error.png', referencia: 'error ar reemplazar archivo.png', nota: 'Fallo real de indexación: se conserva la versión vigente y no se publica la nueva.' },
  { archivo: '15-eliminar-dialogo.png', referencia: 'Eliminar documento.png', nota: 'Confirmación explícita antes de eliminar.' },
  { archivo: '16-eliminacion-incompleta.png', referencia: 'Eliminacion incompleta.png', nota: 'El índice conservó 1 embedding: no se informa éxito y el documento queda bloqueado.' },
  { archivo: '17-eliminado-exito.png', referencia: 'Exito eliminado.png', nota: 'Reintento completo: fragmentos, embeddings y registro retirados.' },
  { archivo: '18-visor-json.png', referencia: null, nota: 'JSON original de la versión usada: formateado, rutas resaltadas y SHA-256 verificado en el navegador.' },
  { archivo: '19-visor-json-completo.png', referencia: null, nota: 'La misma vista completa: JSON, fragmentos indexados con sus rutas y registro técnico.' },
  { archivo: '20-fuente-externa.png', referencia: null, nota: 'Artículo de ForUsGuide: se muestran sus fragmentos indexados y se avisa que no es el JSON original.' },
  { archivo: '21-movil-consulta.png', referencia: null, nota: 'Consulta en móvil.' },
  { archivo: '22-movil-resultados.png', referencia: null, nota: 'Resultados en móvil.' },
  { archivo: '23-movil-documentos.png', referencia: null, nota: 'Documentos en móvil: cada artículo como tarjeta.' },
]

export function datosDe(archivo: string): Captura {
  const captura = CAPTURAS.find(item => item.archivo === archivo)
  if (!captura) throw new Error(`La captura ${archivo} no está en el catálogo de comparacion.ts`)
  return captura
}

const escapar = (texto: string) => texto.replace(/[&<>"']/g, caracter => `&#${caracter.charCodeAt(0)};`)

// Las referencias principales (Consulta y Resultados) son PDF: un PDF no se puede
// mostrar con <img>, así que se incrusta con <object> y siempre queda un enlace.
function celdaReferencia(referencia: string | null): string {
  if (!referencia) return '<span>Sin referencia: pantalla ampliada</span>'
  const ruta = `../negocio/IMAGENES/${encodeURIComponent(referencia)}`
  if (/\.pdf$/i.test(referencia)) {
    return `<object data="${ruta}" type="application/pdf" width="560" height="720" aria-label="${escapar(referencia)}"><a href="${ruta}">Abrir ${escapar(referencia)}</a></object><br><a href="${ruta}">${escapar(referencia)} (PDF)</a>`
  }
  return `<a href="${ruta}"><img src="${ruta}" alt="${escapar(referencia)}"></a><br><span>${escapar(referencia)}</span>`
}

// Escribe comparacion.html con las capturas que existen. Falla si una
// referencia del catálogo no existe, para no publicar enlaces rotos.
export function generarComparacion(salida: string): number {
  const imagenes = path.resolve(salida, '..', 'negocio', 'IMAGENES')
  const presentes = CAPTURAS.filter(item => existsSync(path.join(salida, item.archivo)))
  for (const item of presentes) {
    if (item.referencia && !existsSync(path.join(imagenes, item.referencia))) throw new Error(`No existe la referencia ${item.referencia}`)
  }
  const filas = presentes.map(item => `<tr><td><strong>${escapar(item.archivo)}</strong><br><span>${escapar(item.nota)}</span></td>
<td><a href="${encodeURIComponent(item.archivo)}"><img src="${encodeURIComponent(item.archivo)}" alt="${escapar(item.archivo)}"></a></td>
<td>${celdaReferencia(item.referencia)}</td></tr>`).join('\n')
  writeFileSync(path.join(salida, 'comparacion.html'), `<!doctype html>
<html lang="es">
<meta charset="utf-8">
<title>Knowledge Desk · capturas frente a referencias</title>
<style>body{font:14px/1.4 system-ui;margin:24px;color:#1f2937}table{border-collapse:collapse;width:100%}td{vertical-align:top;border-top:1px solid #ddd;padding:12px}img,object{max-width:560px;border:1px solid #ccc}span{color:#555}</style>
<h1>Capturas finales (modo simulado) frente a las referencias</h1>
<p>Servidor real de Knowledge Desk con índice y servicio de consulta simulados en este equipo. Conteos, fechas e IDs son los reales del pipeline; no se copian de las referencias. Las referencias de Consulta y Resultados son PDF: se incrustan si el navegador tiene visor de PDF y siempre tienen enlace.</p>
<table><thead><tr><th>Captura</th><th>Knowledge Desk</th><th>Referencia</th></tr></thead><tbody>
${filas}
</tbody></table>
</html>
`, 'utf8')
  return presentes.length
}

const esteArchivo = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === esteArchivo) {
  const salida = path.resolve(path.dirname(esteArchivo), '..', '..', '..', 'docs', 'verificacion')
  console.log(`comparacion.html generada con ${generarComparacion(salida)} capturas.`)
}
