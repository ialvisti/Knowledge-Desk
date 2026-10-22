import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { json } from './support/articulos.ts'
import { PREGUNTA_VIATICOS, VIATICOS_V1, VIATICOS_V2 } from './support/demo-documentos.ts'
import { crearEntorno, idsCon, type Entorno } from './support/entorno.ts'

function errorDeDisco(): NodeJS.ErrnoException {
  return Object.assign(new Error('EACCES: permiso denegado (simulado)'), { code: 'EACCES' })
}

async function cargar(entorno: Entorno, nombre: string, contenido: Buffer) {
  const respuesta = await entorno.subir(nombre, contenido)
  await entorno.servicios.gestor.esperarInactividad()
  return respuesta.json().documento.id as string
}

describe('Revisión · la limpieza posterior a publicar nunca deshace la versión nueva', () => {
  let entorno: Entorno
  before(async () => { entorno = await crearEntorno() })
  after(async () => entorno.cerrar())

  it('un EACCES al retirar la versión anterior deja la nueva activa y la anterior pendiente de limpieza', async () => {
    const id = await cargar(entorno, 'Politica_Viaticos.json', json(VIATICOS_V1))
    const registro = entorno.servicios.registro
    const original = registro.eliminarFragmentos.bind(registro)
    registro.eliminarFragmentos = async (docId, version) => {
      if (version === '1.0') throw errorDeDisco()
      return original(docId, version)
    }
    const respuesta = await entorno.subir('Politica_Viaticos_nueva.json', json(VIATICOS_V2), `/api/documentos/${id}/reemplazo`)
    await entorno.servicios.gestor.esperarInactividad()
    registro.eliminarFragmentos = original

    const doc = registro.documento(id)!
    assert.equal(doc.estado, 'indexado')
    assert.equal(doc.versionActiva, '1.1')
    assert.equal(doc.versiones.find(version => version.version === '1.1')!.estado, 'activa')
    const anterior = doc.versiones.find(version => version.version === '1.0')!
    assert.equal(anterior.estado, 'reemplazada')
    assert.notEqual(anterior.embeddingsResiduales, 0, 'queda marcada para limpieza')
    assert.ok(idsCon(entorno.pinecone, 'kd_doc0001_v1_1_').length > 0, 'los embeddings nuevos siguen publicados')
    const { operacion } = (await entorno.app.inject(`/api/operaciones/${respuesta.json().operacion.id}`)).json()
    assert.equal(operacion.resultado, 'exitoso')
    assert.match(operacion.mensaje, /limpieza de la versión anterior quedó pendiente/)

    // La versión anterior no sustenta respuestas aunque sus embeddings sigan.
    const consulta = await entorno.preguntar(PREGUNTA_VIATICOS)
    assert.doesNotMatch(JSON.stringify(consulta.cuerpo.sources ?? []), /kd_doc0001_v1_0/)

    // La limpieza diferida termina el trabajo.
    assert.equal(await entorno.servicios.gestor.limpiarResiduos(), 0)
    assert.equal(idsCon(entorno.pinecone, 'kd_doc0001_v1_0_').length, 0)
  })

  it('una versión reemplazada que quedó con residuos (corte entre activar y limpiar) se limpia al reiniciar', async () => {
    const id = 'DOC-0001'
    const respuesta = await entorno.subir('Politica_Viaticos_v3.json', json(VIATICOS_V1), `/api/documentos/${id}/reemplazo`)
    await entorno.servicios.gestor.esperarInactividad()
    assert.equal(respuesta.statusCode, 202)
    // Simula el corte justo después de activar: la anterior quedó con residuos.
    await entorno.servicios.registro.mutar(estado => {
      const reemplazada = estado.documentos[0].versiones.find(version => version.version === '1.1')!
      reemplazada.embeddingsResiduales = -1
    })
    entorno.pinecone.registros.set('kd_doc0001_v1_1_chunk_1', { _id: 'kd_doc0001_v1_1_chunk_1', content: 'residuo', article_id: 'kd_doc0001_v1_1', visibleDesde: 0 })
    await entorno.reiniciar()
    await entorno.servicios.gestor.esperarInactividad()
    assert.equal(idsCon(entorno.pinecone, 'kd_doc0001_v1_1_').length, 0)
    assert.equal(entorno.servicios.gestor.residuosPendientes(), 0)
  })
})

describe('Revisión · una eliminación interrumpida se cierra como parcial y se puede reintentar', () => {
  let entorno: Entorno
  before(async () => { entorno = await crearEntorno() })
  after(async () => entorno.cerrar())

  it('EACCES al borrar fragmentos: operación parcial, reserva liberada, documento bloqueado y totales conservados', async () => {
    const id = await cargar(entorno, 'Politica_Viaticos.json', json(VIATICOS_V1))
    const fragmentos = entorno.servicios.registro.documento(id)!.versiones[0].fragmentos
    const registro = entorno.servicios.registro
    const original = registro.eliminarFragmentos.bind(registro)
    registro.eliminarFragmentos = async () => { throw errorDeDisco() }
    const primera = (await entorno.app.inject({ method: 'POST', url: `/api/documentos/${id}/eliminacion`, payload: { confirmado: true } })).json().operacion
    registro.eliminarFragmentos = original

    assert.equal(primera.resultado, 'fallido_parcial')
    assert.equal(primera.contadores.registro, 'pendiente')
    const doc = registro.documento(id)!
    assert.equal(doc.estado, 'bloqueado')
    assert.equal(doc.operacionEnCurso, null)
    assert.deepEqual(doc.eliminacion, { fragmentosTotal: fragmentos, embeddingsTotal: fragmentos })
    assert.equal((await entorno.preguntar(PREGUNTA_VIATICOS)).cuerpo.code, 'CONTENT_UNAVAILABLE')

    const segunda = (await entorno.app.inject({ method: 'POST', url: `/api/documentos/${id}/eliminacion`, payload: { confirmado: true } })).json().operacion
    assert.equal(segunda.resultado, 'exitoso')
    assert.deepEqual(segunda.contadores.fragmentos, { hechos: fragmentos, total: fragmentos })
    assert.deepEqual(segunda.contadores.embeddings, { hechos: fragmentos, total: fragmentos })
  })

  it('un corte tras borrar los fragmentos no deja el reintento en 0 de 0', async () => {
    const id = await cargar(entorno, 'Manual.json', json(VIATICOS_V2))
    const fragmentos = entorno.servicios.registro.documento(id)!.versiones[0].fragmentos
    const indice = entorno.servicios.indice!
    const eliminar = indice.eliminar.bind(indice)
    indice.eliminar = async () => { throw new TypeError('corte simulado del proceso') }
    const listar = indice.listarIds.bind(indice)
    let llamadas = 0
    indice.listarIds = async (prefijo, signal) => {
      // El primer listado (totales) funciona; luego el índice "se cae".
      if (++llamadas > 1) throw new TypeError('corte simulado del proceso')
      return listar(prefijo, signal)
    }
    const primera = (await entorno.app.inject({ method: 'POST', url: `/api/documentos/${id}/eliminacion`, payload: { confirmado: true } })).json().operacion
    indice.eliminar = eliminar
    indice.listarIds = listar
    assert.equal(primera.resultado, 'fallido_parcial')
    assert.equal(entorno.servicios.registro.documento(id)!.eliminacion!.fragmentosTotal, fragmentos)

    const segunda = (await entorno.app.inject({ method: 'POST', url: `/api/documentos/${id}/eliminacion`, payload: { confirmado: true } })).json().operacion
    assert.equal(segunda.resultado, 'exitoso')
    assert.deepEqual(segunda.contadores.fragmentos, { hechos: fragmentos, total: fragmentos })
  })

  it('D1: totales ilegibles no se guardan como 0; con 2 embeddings restantes sigue parcial y solo el borrado real cierra con éxito', async () => {
    const id = await cargar(entorno, 'Politica_D1.json', json(VIATICOS_V1))
    const total = entorno.servicios.registro.documento(id)!.versiones[0].fragmentos
    const prefijo = `kd_${id.toLowerCase().replace('-', '')}_`
    const eliminar = async () => (await entorno.app.inject({ method: 'POST', url: `/api/documentos/${id}/eliminacion`, payload: { confirmado: true } })).json().operacion
    const registro = entorno.servicios.registro
    const indice = entorno.servicios.indice!
    const leer = registro.leerFragmentos.bind(registro)
    const listar = indice.listarIds.bind(indice)

    // 1. Ni los fragmentos guardados ni el índice se pueden leer al calcular totales.
    registro.leerFragmentos = async () => { throw errorDeDisco() }
    indice.listarIds = async () => { throw new TypeError('el índice no responde (simulado)') }
    const primera = await eliminar()
    registro.leerFragmentos = leer
    indice.listarIds = listar
    assert.equal(primera.resultado, 'fallido_parcial')
    assert.deepEqual(registro.documento(id)!.eliminacion, { fragmentosTotal: total, embeddingsTotal: total }, 'lo desconocido no se guarda como 0')
    assert.equal(idsCon(entorno.pinecone, prefijo).length, total)

    // 2. Reintento: el índice borra todo menos 2 embeddings. No es un éxito.
    entorno.pinecone.fallos.borradoDeja = 2
    const segunda = await eliminar()
    entorno.pinecone.fallos.borradoDeja = 0
    assert.equal(segunda.resultado, 'fallido_parcial')
    assert.deepEqual(segunda.contadores.embeddings, { hechos: total - 2, total })
    assert.equal(segunda.contadores.registro, 'pendiente')
    assert.match(segunda.mensaje, /Quedan 2 embeddings/)
    assert.equal(registro.documento(id)!.estado, 'bloqueado')
    assert.equal(idsCon(entorno.pinecone, prefijo).length, 2)
    assert.doesNotMatch(JSON.stringify((await entorno.preguntar(PREGUNTA_VIATICOS)).cuerpo.sources ?? []), new RegExp(prefijo))

    // 3. Solo cuando el índice confirma 0 restantes se retira el documento.
    const tercera = await eliminar()
    assert.equal(tercera.resultado, 'exitoso')
    assert.deepEqual(tercera.contadores.embeddings, { hechos: total, total })
    assert.equal(idsCon(entorno.pinecone, prefijo).length, 0)
    assert.equal(registro.documento(id)!.estado, 'retirado')
  })
})

describe('Revisión · los conteos de una eliminación no incluyen versiones ya limpiadas', () => {
  let entorno: Entorno
  before(async () => { entorno = await crearEntorno() })
  after(async () => entorno.cerrar())

  it('tras un reemplazo, el total de embeddings es el de lo que puede seguir en el índice y el parcial es real', async () => {
    const id = await cargar(entorno, 'Politica.json', json(VIATICOS_V1))
    await entorno.subir('Politica_v2.json', json(VIATICOS_V2), `/api/documentos/${id}/reemplazo`)
    await entorno.servicios.gestor.esperarInactividad()
    assert.equal(idsCon(entorno.pinecone, 'kd_doc0001_v1_0_').length, 0, 'la versión anterior ya se limpió')
    const vigentes = idsCon(entorno.pinecone, 'kd_doc0001_v1_1_').length
    const eliminar = async () => (await entorno.app.inject({ method: 'POST', url: `/api/documentos/${id}/eliminacion`, payload: { confirmado: true } })).json().operacion

    entorno.pinecone.fallos.borradoDeja = 1
    const parcial = await eliminar()
    entorno.pinecone.fallos.borradoDeja = 0
    assert.equal(parcial.resultado, 'fallido_parcial')
    assert.deepEqual(parcial.contadores.embeddings, { hechos: vigentes - 1, total: vigentes })
    assert.equal(idsCon(entorno.pinecone, 'kd_doc0001_').length, 1)

    const final = await eliminar()
    assert.equal(final.resultado, 'exitoso')
    assert.deepEqual(final.contadores.embeddings, { hechos: vigentes, total: vigentes })
  })
})

describe('Revisión · la consulta comprueba la disponibilidad después del último await', () => {
  let entorno: Entorno
  before(async () => { entorno = await crearEntorno() })
  after(async () => entorno.cerrar())

  it('si el documento se retira mientras se arman las fuentes, la respuesta no sale con la fuente vieja', async () => {
    const id = await cargar(entorno, 'Politica_Viaticos.json', json(VIATICOS_V1))
    const registro = entorno.servicios.registro
    const original = registro.leerFragmentos.bind(registro)
    let retirado = false
    registro.leerFragmentos = async (docId, version) => {
      if (!retirado) {
        retirado = true
        await registro.mutar(estado => {
          const doc = estado.documentos.find(item => item.id === id)!
          doc.estado = 'bloqueado'
          estado.revision += 1
        })
      }
      return original(docId, version)
    }
    const { status, cuerpo } = await entorno.preguntar(PREGUNTA_VIATICOS)
    registro.leerFragmentos = original
    assert.equal(status, 409)
    assert.equal(cuerpo.code, 'CONTENT_UNAVAILABLE')
  })

  it('la revisión devuelta es la que se comprobó', async () => {
    await entorno.servicios.registro.mutar(estado => { estado.documentos[0].estado = 'indexado' })
    const { cuerpo } = await entorno.preguntar(PREGUNTA_VIATICOS)
    assert.equal(cuerpo.corpus_revision, entorno.servicios.registro.revision)
  })
})
