import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { articulo, articuloSimple, json } from './support/articulos.ts'
import { ARTICULOS_DEMO, PREGUNTA_VIATICOS, VIATICOS_V1, VIATICOS_V2 } from './support/demo-documentos.ts'
import { crearEntorno, idsCon, type Entorno } from './support/entorno.ts'

async function cargarListo(entorno: Entorno, nombre: string, contenido: Buffer) {
  const respuesta = await entorno.subir(nombre, contenido)
  assert.equal(respuesta.statusCode, 202, respuesta.body)
  await entorno.servicios.gestor.esperarInactividad()
  return respuesta.json().documento.id as string
}

const eliminar = (entorno: Entorno, id: string) => entorno.app.inject({ method: 'POST', url: `/api/documentos/${id}/eliminacion`, payload: { confirmado: true } })

describe('HU07 · incorporar un artículo de conocimiento JSON', () => {
  let entorno: Entorno
  before(async () => { entorno = await crearEntorno() })
  after(async () => entorno.cerrar())

  it('valida, fragmenta por secciones, indexa y verifica antes de marcarlo Indexado; la consulta lo cita por ruta JSON', async () => {
    const respuesta = await entorno.subir('Politica_Viaticos_v3.2.json', json(VIATICOS_V1))
    assert.equal(respuesta.statusCode, 202)
    assert.equal(respuesta.json().documento.estado, 'procesando')
    assert.equal(respuesta.json().documento.articuloId, 'politica_viaticos_internacionales')
    await entorno.servicios.gestor.esperarInactividad()

    const { documentos } = (await entorno.app.inject('/api/documentos')).json()
    assert.equal(documentos.length, 1)
    const doc = documentos[0]
    assert.equal(doc.nombre, 'Politica_Viaticos_v3.2.json')
    assert.equal(doc.titulo, 'Política de viáticos internacionales')
    assert.equal(doc.tipo, 'json')
    assert.equal(doc.estado, 'indexado')
    const ids = idsCon(entorno.pinecone, 'kd_doc0001_v1_0_chunk_')
    assert.equal(doc.fragmentos, ids.length)
    assert.ok(ids.length >= 5)

    // Metadatos que ForUsGuide lee de cada fragmento (ChunkMetadata), con el
    // centinela "all" para record_keeper/plan_type nulos y el ID canónico aparte.
    const registro = entorno.pinecone.registros.get('kd_doc0001_v1_0_chunk_1')!
    for (const campo of ['article_id', 'article_title', 'chunk_type', 'chunk_tier', 'chunk_category', 'content', 'content_hash']) assert.ok(registro[campo], campo)
    assert.equal(registro.article_id, 'kd_doc0001_v1_0')
    assert.equal(registro.article_title, 'Política de viáticos internacionales')
    assert.equal(registro.record_keeper, 'all')
    assert.equal(registro.plan_type, 'all')
    assert.equal(registro.source_article_id, 'politica_viaticos_internacionales')
    assert.ok(Array.isArray(registro.kd_json_paths) && (registro.kd_json_paths as string[]).every(ruta => ruta.startsWith('details.')))
    assert.equal(registro.page, undefined)

    const { operacion } = (await entorno.app.inject(`/api/operaciones/${respuesta.json().operacion.id}`)).json()
    assert.equal(operacion.resultado, 'exitoso')
    assert.deepEqual(operacion.pasos.map((paso: { nombre: string }) => paso.nombre), ['validacion', 'lectura', 'fragmentacion', 'embeddings', 'verificacion', 'activacion'])
    assert.match(operacion.pasos[0].detalle, /JSON kb_article_v2 válido · artículo politica_viaticos_internacionales/)

    const { status, cuerpo } = await entorno.preguntar(PREGUNTA_VIATICOS)
    assert.equal(status, 200)
    assert.equal(cuerpo.outcome, 'answered')
    const fuente = cuerpo.sources.find((item: { document_id: string }) => item.document_id === doc.id)
    assert.ok(fuente, 'el artículo indexado sustenta la respuesta')
    assert.equal(fuente.kind, 'document')
    assert.equal(fuente.title, 'Política de viáticos internacionales')
    assert.equal(fuente.file_name, 'Politica_Viaticos_v3.2.json')
    assert.equal(fuente.article_id, 'politica_viaticos_internacionales')
    assert.equal(fuente.href, `/documentos/${doc.id}?version=1.0`)
    assert.match(fuente.location, /^details\./)
    for (const fragmento of fuente.fragments) assert.ok(fragmento.paths.length > 0 && fragmento.paths.every((ruta: string) => ruta.startsWith('details.')))
  })

  it('el JSON original se guarda y se entrega byte a byte, con su SHA-256; el detalle muestra artículo y fragmentos', async () => {
    // CRLF, tabulaciones, BOM y orden propio: nada de esto se normaliza.
    const texto = JSON.stringify(articuloSimple('bytes_intactos', 'Bytes intactos', 'Primer paso con suficiente texto para indexarse.', 'Segundo paso con más contenido útil.'), null, '\t').replace(/\n/g, '\r\n')
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(texto, 'utf8')])
    const id = await cargarListo(entorno, 'Bytes_Intactos.json', original)

    const archivo = await entorno.app.inject(`/api/documentos/${id}/archivo?version=1.0`)
    assert.equal(archivo.statusCode, 200)
    assert.match(String(archivo.headers['content-type']), /^application\/json; charset=utf-8/)
    assert.match(String(archivo.headers['content-disposition']), /^inline; filename\*=UTF-8''Bytes_Intactos\.json/)
    assert.ok(archivo.rawPayload.equals(original), 'mismos bytes que se cargaron')
    assert.equal(archivo.headers['x-content-sha256'], createHash('sha256').update(original).digest('hex'))
    const descarga = await entorno.app.inject(`/api/documentos/${id}/archivo?version=1.0&descargar=1`)
    assert.match(String(descarga.headers['content-disposition']), /^attachment;/)

    const detalle = (await entorno.app.inject(`/api/documentos/${id}`)).json()
    assert.equal(detalle.version.tipo, 'json')
    assert.equal(detalle.version.sha256, archivo.headers['x-content-sha256'])
    assert.equal(detalle.version.articulo.id, 'bytes_intactos')
    assert.equal(detalle.version.archivoUrl, `/api/documentos/${id}/archivo?version=1.0`)
    assert.deepEqual(detalle.fragmentos.map((item: { rutas: string[] }) => item.rutas), [['details.steps[0]', 'details.steps[1]']])
    assert.equal(detalle.fragmentos[0].nivel, 'high')
  })

  it('un artículo sin contenido indexable (solo claves ajenas o secciones vacías) queda en Error y nunca se publica', async () => {
    const id = await cargarListo(entorno, 'Borrador_Incompleto.json', json(ARTICULOS_DEMO['Borrador_Incompleto.json']))
    const doc = entorno.servicios.registro.documento(id)!
    assert.equal(doc.estado, 'error')
    assert.equal(doc.error!.etapa, 'lectura')
    assert.match(doc.error!.mensaje, /no tiene contenido indexable/)
    assert.equal(doc.versionActiva, null)
    assert.equal(idsCon(entorno.pinecone, `kd_${id.toLowerCase().replace('-', '')}_`).length, 0)
    const ajeno = await cargarListo(entorno, 'Solo_Ajeno.json', json(articulo('solo_ajeno', 'Solo ajeno', { dato_ajeno: 'Texto largo fuera del esquema que no se indexa en ninguna sección.' })))
    assert.equal(entorno.servicios.registro.documento(ajeno)!.estado, 'error')
    assert.equal(entorno.servicios.registro.operacionesDe(ajeno)[0].resultado, 'fallido')
  })

  it('rechaza otros formatos, vacíos, JSON inválido, artículos mal formados y más de 50 MB sin guardar nada', async () => {
    const casos: [string, Buffer, number, string][] = [
      ['foto.png', Buffer.from('png'), 415, 'UNSUPPORTED_FORMAT'],
      ['Politica.pdf', json(VIATICOS_V1), 415, 'UNSUPPORTED_FORMAT'],
      ['Manual.docx', json(VIATICOS_V1), 415, 'UNSUPPORTED_FORMAT'],
      ['vacio.json', Buffer.alloc(0), 400, 'EMPTY_FILE'],
      ['malformado.json', Buffer.from('{"metadata": {"article_id": '), 422, 'INVALID_ARTICLE'],
      ['sin_details.json', Buffer.from('{"metadata": {"article_id": "a", "title": "T", "record_keeper": null, "plan_type": null}}'), 422, 'INVALID_ARTICLE'],
      ['anidado.json', json(articulo('anidado', 'Anidado', { steps: [{ description: 'Uno' }, { description: ['no', 'texto'] }] })), 422, 'INVALID_ARTICLE'],
      ['enorme.json', Buffer.alloc(50 * 1024 * 1024 + 1, ' '), 413, 'FILE_TOO_LARGE'],
    ]
    const antes = (await entorno.app.inject('/api/documentos')).json().documentos.length
    for (const [nombre, contenido, status, code] of casos) {
      const respuesta = await entorno.subir(nombre, contenido)
      assert.equal(respuesta.statusCode, status, nombre)
      assert.equal(respuesta.json().code, code, nombre)
      assert.ok(respuesta.json().message.length > 10)
      assert.match(respuesta.json().request_id, /^req-[0-9a-f]{8}$/)
    }
    const anidado = await entorno.subir('anidado.json', json(articulo('anidado', 'Anidado', { steps: [{ description: 'Uno' }, { description: 3 }] })))
    assert.match(anidado.json().message, /details\.steps\[1\]\.description/)
    assert.equal((await entorno.app.inject('/api/documentos')).json().documentos.length, antes)
  })

  it('no admite dos documentos vigentes con el mismo nombre ni el mismo artículo canónico', async () => {
    const nombre = await entorno.subir('politica_viaticos_V3.2.JSON', json(VIATICOS_V2))
    assert.equal(nombre.statusCode, 409)
    assert.equal(nombre.json().code, 'DUPLICATE_DOCUMENT')
    const articuloRepetido = await entorno.subir('Otra_Copia_Viaticos.json', json(VIATICOS_V2))
    assert.equal(articuloRepetido.statusCode, 409)
    assert.equal(articuloRepetido.json().code, 'DUPLICATE_ARTICLE')
    assert.match(articuloRepetido.json().message, /Usa Editar/)
  })

  it('un artículo que ya existe en el corpus de ForUsGuide no se duplica desde Knowledge Desk', async () => {
    entorno.pinecone.registros.set('rollover_externo_chunk_1', { _id: 'rollover_externo_chunk_1', content: 'artículo del corpus externo', article_id: 'rollover_externo', visibleDesde: 0 })
    const respuesta = await entorno.subir('Rollover.json', json(articuloSimple('rollover_externo', 'Rollover', 'Paso con contenido suficiente para indexar.')))
    assert.equal(respuesta.statusCode, 409)
    assert.equal(respuesta.json().code, 'DUPLICATE_ARTICLE')
    assert.match(respuesta.json().message, /corpus de ForUsGuide/)
  })

  it('un nombre con ruta no escapa del directorio de datos', async () => {
    const id = await cargarListo(entorno, '..\\..\\fuera.json', json(articuloSimple('ruta_segura', 'Ruta segura', 'Texto suficiente para indexar el artículo de prueba.')))
    const { documento, version } = (await entorno.app.inject(`/api/documentos/${id}`)).json()
    assert.equal(documento.nombre, 'fuera.json')
    assert.equal(version.nombre, 'fuera.json')
    assert.equal((await entorno.app.inject('/api/documentos/..%2F..%2Fregistro.json')).statusCode, 404)
    assert.ok(!existsSync(path.join(entorno.dataDir, 'fuera.json')))
  })
})

describe('Disponibilidad: solo lo verificado se publica', () => {
  let entorno: Entorno
  before(async () => { entorno = await crearEntorno() })
  after(async () => entorno.cerrar())

  it('espera a que el índice muestre todos los registros antes de declarar Indexado', async () => {
    entorno.pinecone.fallos.retrasoVisibilidadMs = 400
    const id = await cargarListo(entorno, 'Manual_Gastos.json', json(ARTICULOS_DEMO['Manual_Gastos.json']))
    entorno.pinecone.fallos.retrasoVisibilidadMs = 0
    assert.equal(entorno.servicios.registro.documento(id)!.estado, 'indexado')
  })

  it('si el índice nunca confirma la versión, no se publica y se retira lo enviado', async () => {
    entorno.pinecone.fallos.retrasoVisibilidadMs = 60_000
    const id = await cargarListo(entorno, 'Lento.json', json(articuloSimple('lento', 'Lento', 'Procedimiento de prueba con texto suficiente para indexar.')))
    entorno.pinecone.fallos.retrasoVisibilidadMs = 0
    const doc = entorno.servicios.registro.documento(id)!
    assert.equal(doc.estado, 'error')
    assert.equal(doc.error!.etapa, 'verificacion')
    assert.equal(idsCon(entorno.pinecone, 'kd_doc0002_').length, 0)
  })
})

describe('HU08 · reemplazar un artículo', () => {
  let entorno: Entorno
  let id: string
  before(async () => {
    entorno = await crearEntorno()
    id = await cargarListo(entorno, 'Politica_Viaticos_v3.2.json', json(VIATICOS_V1))
  })
  after(async () => entorno.cerrar())

  it('el reemplazo debe ser del mismo artículo canónico', async () => {
    const respuesta = await entorno.subir('Otro.json', json(ARTICULOS_DEMO['Manual_Gastos.json']), `/api/documentos/${id}/reemplazo`)
    assert.equal(respuesta.statusCode, 409)
    assert.equal(respuesta.json().code, 'ARTICLE_MISMATCH')
    assert.equal(entorno.servicios.registro.documento(id)!.versiones.length, 1)
  })

  it('si falla la reindexación, conserva la versión vigente y no publica fragmentos de la nueva', async () => {
    const vigentes = idsCon(entorno.pinecone, 'kd_doc0001_v1_0_').length
    entorno.pinecone.fallos.upsertFalla = 'kd_doc0001_v1_1'
    const respuesta = await entorno.subir('Politica_Viaticos_v3.3.json', json(VIATICOS_V2), `/api/documentos/${id}/reemplazo`)
    assert.equal(respuesta.statusCode, 202)
    await entorno.servicios.gestor.esperarInactividad()
    entorno.pinecone.fallos.upsertFalla = null

    const { operacion } = (await entorno.app.inject(`/api/operaciones/${respuesta.json().operacion.id}`)).json()
    assert.equal(operacion.resultado, 'fallido')
    assert.match(operacion.mensaje, new RegExp(`Se conserva la versión v1\\.0 con sus ${vigentes} fragmentos`))
    const doc = entorno.servicios.registro.documento(id)!
    assert.equal(doc.versionActiva, '1.0')
    assert.equal(doc.estado, 'indexado')
    assert.equal(idsCon(entorno.pinecone, 'kd_doc0001_v1_1_').length, 0)
    assert.equal(idsCon(entorno.pinecone, 'kd_doc0001_v1_0_').length, vigentes)
  })

  it('el reemplazo exitoso activa la nueva versión, retira la anterior y no mezcla contenido', async () => {
    const respuesta = await entorno.subir('Politica_Viaticos_v3.3.json', json(VIATICOS_V2), `/api/documentos/${id}/reemplazo`)
    await entorno.servicios.gestor.esperarInactividad()
    const { operacion } = (await entorno.app.inject(`/api/operaciones/${respuesta.json().operacion.id}`)).json()
    assert.equal(operacion.resultado, 'exitoso')
    assert.equal(operacion.versionAnterior, '1.0')
    assert.match(operacion.mensaje, /La versión v1\.2 ya está activa/)
    assert.equal(entorno.servicios.registro.documento(id)!.versionActiva, '1.2')
    assert.equal(idsCon(entorno.pinecone, 'kd_doc0001_v1_0_').length, 0)
    const nuevos = idsCon(entorno.pinecone, 'kd_doc0001_v1_2_')
    assert.ok(nuevos.length > 0)
    const contenido = nuevos.map(clave => entorno.pinecone.registros.get(clave)!.content).join('\n')
    assert.match(contenido, /10 días hábiles/)
    assert.doesNotMatch(contenido, /15 días posteriores/)
    // La versión anterior sigue consultable como JSON auténtico de esa versión.
    const anterior = await entorno.app.inject(`/api/documentos/${id}/archivo?version=1.0`)
    assert.ok(anterior.rawPayload.equals(json(VIATICOS_V1)))
    // Evidencia técnica: documento, fecha, operador y resultado.
    assert.ok(operacion.inicio && operacion.fin && operacion.operador && operacion.documentoId === id)
  })

  it('rechaza una segunda operación simultánea sobre el mismo documento', async () => {
    const [primera, segunda] = await Promise.all([
      entorno.subir('Politica_Viaticos_v3.4.json', json(VIATICOS_V1), `/api/documentos/${id}/reemplazo`),
      eliminar(entorno, id),
    ])
    await entorno.servicios.gestor.esperarInactividad()
    const codigos = [primera.statusCode, segunda.statusCode]
    assert.equal(codigos.filter(codigo => codigo === 409).length, 1, `una sola operación gana: ${codigos}`)
    assert.ok(codigos.some(codigo => codigo === 200 || codigo === 202))
    const rechazada = primera.statusCode === 409 ? primera : segunda
    assert.equal(rechazada.json().code, 'DOCUMENT_BUSY')
  })
})

describe('HU09 · eliminar un artículo', () => {
  let entorno: Entorno
  before(async () => { entorno = await crearEntorno() })
  after(async () => entorno.cerrar())

  it('exige confirmación explícita', async () => {
    const id = await cargarListo(entorno, 'Política_Privacidad_2023.json', json(ARTICULOS_DEMO['Política_Privacidad_2023.json']))
    const respuesta = await entorno.app.inject({ method: 'POST', url: `/api/documentos/${id}/eliminacion`, payload: {} })
    assert.equal(respuesta.statusCode, 400)
    assert.equal(respuesta.json().code, 'CONFIRMATION_REQUIRED')
    assert.equal(entorno.servicios.registro.documento(id)!.estado, 'indexado')
  })

  it('el fallo parcial bloquea el documento, no se informa éxito y el reintento completa la eliminación', async () => {
    const id = await cargarListo(entorno, 'Politica_Viaticos_v3.2.json', json(VIATICOS_V1))
    const total = idsCon(entorno.pinecone, 'kd_doc0002_').length
    entorno.pinecone.fallos.borradoDeja = 1
    let operacion = (await eliminar(entorno, id)).json().operacion
    assert.equal(operacion.resultado, 'fallido_parcial')
    assert.deepEqual(operacion.contadores.embeddings, { hechos: total - 1, total })
    assert.equal(operacion.contadores.fragmentos.hechos, operacion.contadores.fragmentos.total)
    assert.equal(operacion.contadores.registro, 'pendiente')
    assert.match(operacion.mensaje, /Quedan 1 embeddings asociados.*no se registra como exitosa/)
    assert.equal(entorno.servicios.registro.documento(id)!.estado, 'bloqueado')

    // El embedding que quedó en el índice no puede sustentar una respuesta.
    const bloqueada = await entorno.preguntar(PREGUNTA_VIATICOS)
    assert.equal(bloqueada.status, 409)
    assert.equal(bloqueada.cuerpo.code, 'CONTENT_UNAVAILABLE')

    entorno.pinecone.fallos.borradoDeja = 0
    operacion = (await eliminar(entorno, id)).json().operacion
    assert.equal(operacion.resultado, 'exitoso')
    assert.deepEqual(operacion.contadores.embeddings, { hechos: total, total })
    assert.equal(operacion.contadores.registro, 'retirado')
    assert.equal(idsCon(entorno.pinecone, 'kd_doc0002_').length, 0)
    assert.ok(!(await entorno.app.inject('/api/documentos')).json().documentos.some((doc: { id: string }) => doc.id === id))
  })

  it('archivar es idempotente: un original ya movido no bloquea el reintento', async () => {
    const id = await cargarListo(entorno, 'Guia_Estilo.json', json(ARTICULOS_DEMO['Guia_Estilo_Archivistica.json']))
    const version = entorno.servicios.registro.documento(id)!.versiones[0]
    const origen = entorno.servicios.registro.rutaArchivo(version.archivo.ruta)
    const archivado = entorno.servicios.registro.rutaArchivo(version.archivo.ruta.replace(/^archivos/, 'archivo-retirados'))
    await mkdir(path.dirname(archivado), { recursive: true })
    await rename(origen, archivado) // como si un intento anterior se hubiera cortado tras mover el original
    const { operacion } = (await eliminar(entorno, id)).json()
    assert.equal(operacion.resultado, 'exitoso')
    assert.ok(existsSync(archivado))
  })
})

describe('Persistencia y recuperación', () => {
  let entorno: Entorno
  before(async () => { entorno = await crearEntorno() })
  after(async () => entorno.cerrar())

  it('el registro, los fragmentos y las operaciones sobreviven a un reinicio', async () => {
    const id = await cargarListo(entorno, 'Manual_Gastos.json', json(ARTICULOS_DEMO['Manual_Gastos.json']))
    const antes = (await entorno.app.inject(`/api/documentos/${id}`)).json()
    await entorno.reiniciar()
    const despues = (await entorno.app.inject(`/api/documentos/${id}`)).json()
    assert.equal(despues.documento.estado, 'indexado')
    assert.deepEqual(despues.fragmentos, antes.fragmentos)
    assert.equal(despues.fragmentos.length, 2)
    assert.equal(despues.operaciones.length, 1)
  })

  it('una operación interrumpida por un reinicio no queda "Procesando" para siempre', async () => {
    await entorno.servicios.registro.mutar(estado => {
      const doc = estado.documentos[0]
      doc.estado = 'procesando'
      doc.versiones.push({ ...doc.versiones[0], version: '1.1', articleId: 'kd_doc0001_v1_1', estado: 'procesando' })
      doc.operacionEnCurso = 'OP-2026-9999'
    })
    await entorno.reiniciar()
    const doc = entorno.servicios.registro.documento('DOC-0001')!
    assert.equal(doc.estado, 'indexado')
    assert.equal(doc.operacionEnCurso, null)
    assert.equal(doc.versiones.find(version => version.version === '1.1')!.estado, 'fallida')
  })
})

describe('Ciclo completo: cargar → preguntar → reemplazar → preguntar → eliminar → preguntar', () => {
  let entorno: Entorno
  before(async () => { entorno = await crearEntorno() })
  after(async () => entorno.cerrar())

  it('cada consulta usa solo la versión vigente y nunca resucita un documento retirado', async () => {
    const id = await cargarListo(entorno, 'Politica_Viaticos.json', json(VIATICOS_V1))
    const primera = await entorno.preguntar(PREGUNTA_VIATICOS)
    assert.equal(primera.cuerpo.outcome, 'answered')
    assert.ok(primera.cuerpo.sources.some((fuente: { id: string }) => fuente.id === 'kd_doc0001_v1_0'))
    assert.match(JSON.stringify(primera.cuerpo.sources), /15 días/)

    await entorno.subir('Politica_Viaticos_actualizada.json', json(VIATICOS_V2), `/api/documentos/${id}/reemplazo`)
    await entorno.servicios.gestor.esperarInactividad()
    const segunda = await entorno.preguntar(PREGUNTA_VIATICOS)
    assert.ok(segunda.cuerpo.corpus_revision > primera.cuerpo.corpus_revision)
    const textoSegunda = JSON.stringify(segunda.cuerpo.sources)
    assert.match(textoSegunda, /10 días hábiles/)
    assert.doesNotMatch(textoSegunda, /kd_doc0001_v1_0|15 días posteriores/)

    await eliminar(entorno, id)
    const tercera = await entorno.preguntar(PREGUNTA_VIATICOS)
    assert.ok(tercera.cuerpo.corpus_revision > segunda.cuerpo.corpus_revision)
    assert.equal(tercera.cuerpo.outcome, 'insufficient')
    assert.equal(tercera.cuerpo.coverage.level, 'sin_evidencia')
    assert.doesNotMatch(JSON.stringify(tercera.cuerpo), /kd_doc0001/)
  })
})
