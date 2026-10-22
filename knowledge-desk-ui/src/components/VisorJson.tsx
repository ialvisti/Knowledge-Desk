import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { anclaRuta } from '../lib/rutas'
import { Icon } from './ui'

// Visor del JSON auténtico de un artículo de conocimiento. Dos vistas:
//  - Formateado: el JSON del archivo, indentado y con las rutas usadas en una
//    respuesta resaltadas. React escapa todo el texto: nada del JSON se
//    interpreta como HTML.
//  - Original exacto: el texto tal como se cargó, sin reformatear.
// Un JSON grande se muestra solo sin formato para no bloquear el navegador.
const MAX_CARACTERES_FORMATO = 1_500_000
const MAX_NODOS_FORMATO = 40_000

type Json = null | boolean | number | string | Json[] | { [clave: string]: Json }

function contarNodos(valor: Json, limite: number): number {
  let total = 0
  const pila: Json[] = [valor]
  while (pila.length && total <= limite) {
    const actual = pila.pop()!
    total++
    if (Array.isArray(actual)) pila.push(...actual)
    else if (actual !== null && typeof actual === 'object') pila.push(...Object.values(actual))
  }
  return total
}

function Primitivo({ valor }: { valor: Exclude<Json, object> | null }) {
  if (valor === null) return <span className="json-null">null</span>
  if (typeof valor === 'string') return <span className="json-string">{JSON.stringify(valor)}</span>
  if (typeof valor === 'number') return <span className="json-number">{String(valor)}</span>
  return <span className="json-boolean">{String(valor)}</span>
}

function Nodo({ valor, clave, ruta, nivel, coma, usadas }: { valor: Json; clave: string | null; ruta: string; nivel: number; coma: boolean; usadas: Set<string> }): ReactNode {
  const sangria: CSSProperties = { '--nivel': nivel } as CSSProperties
  const prefijo = clave !== null && <><span className="json-key">{JSON.stringify(clave)}</span><span className="json-punct">: </span></>
  const final = coma && <span className="json-punct">,</span>
  let lineas: ReactNode
  if (valor !== null && typeof valor === 'object') {
    const esLista = Array.isArray(valor)
    const entradas: [string, Json][] = esLista ? valor.map((item, indice) => [String(indice), item]) : Object.entries(valor)
    const [abre, cierra] = esLista ? ['[', ']'] : ['{', '}']
    lineas = entradas.length === 0
      ? <div className="json-linea" style={sangria}>{prefijo}<span className="json-punct">{abre}{cierra}</span>{final}</div>
      : <>
        <div className="json-linea" style={sangria}>{prefijo}<span className="json-punct">{abre}</span></div>
        {entradas.map(([subclave, subvalor], posicion) => <Nodo key={subclave} valor={subvalor} clave={esLista ? null : subclave}
          ruta={esLista ? `${ruta}[${subclave}]` : ruta ? `${ruta}.${subclave}` : subclave}
          nivel={nivel + 1} coma={posicion < entradas.length - 1} usadas={usadas} />)}
        <div className="json-linea" style={sangria}><span className="json-punct">{cierra}</span>{final}</div>
      </>
  } else {
    lineas = <div className="json-linea" style={sangria}>{prefijo}<Primitivo valor={valor} />{final}</div>
  }
  if (!usadas.has(ruta)) return lineas
  return <div className="json-usado" id={anclaRuta(ruta)} data-ruta={ruta}>
    <span className="json-usado-etiqueta">{ruta}</span>
    {lineas}
  </div>
}

async function sha256(bytes: Uint8Array): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null
  const resumen = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(resumen), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function VisorJson({ texto, bytes, sha256Esperado, rutasUsadas = [], descargaUrl, nombre }: {
  texto: string
  bytes?: Uint8Array
  sha256Esperado?: string | null
  rutasUsadas?: string[]
  descargaUrl?: string | null
  nombre: string
}) {
  const analizado = useMemo(() => {
    try {
      const valor = JSON.parse(texto) as Json
      const grande = texto.length > MAX_CARACTERES_FORMATO || contarNodos(valor, MAX_NODOS_FORMATO) > MAX_NODOS_FORMATO
      return { valor, grande, error: null }
    } catch (error) {
      return { valor: null, grande: false, error: (error as Error).message }
    }
  }, [texto])
  const formateable = analizado.error === null && !analizado.grande
  const [vista, setVista] = useState<'formateado' | 'original'>(formateable ? 'formateado' : 'original')
  const [copiado, setCopiado] = useState<'si' | 'no' | null>(null)
  const [integridad, setIntegridad] = useState<{ calculado: string | null } | null>(null)
  const usadas = useMemo(() => new Set(rutasUsadas), [rutasUsadas])

  useEffect(() => {
    if (!bytes) return
    let activo = true
    sha256(bytes).then(calculado => { if (activo) setIntegridad({ calculado }) }, () => { if (activo) setIntegridad({ calculado: null }) })
    return () => { activo = false }
  }, [bytes])

  // Al abrir desde una fuente, se lleva la vista a la primera sección usada.
  useEffect(() => {
    if (vista !== 'formateado' || !rutasUsadas.length) return
    document.getElementById(anclaRuta(rutasUsadas[0]))?.scrollIntoView({ block: 'center' })
  }, [vista, rutasUsadas])

  const verificacion = !bytes || !sha256Esperado ? null
    : integridad === null ? <span className="json-integrity"><Icon name="hourglass_empty" />Verificando SHA-256…</span>
      : integridad.calculado === null ? <span className="json-integrity"><Icon name="info" />SHA-256 declarado {sha256Esperado.slice(0, 12)}… (este navegador no permite verificarlo sin HTTPS)</span>
        : integridad.calculado === sha256Esperado
          ? <span className="json-integrity json-integrity-ok"><Icon name="verified" filled />SHA-256 verificado: {sha256Esperado.slice(0, 16)}…</span>
          : <span className="json-integrity json-integrity-fail" role="alert"><Icon name="error" filled />El SHA-256 del archivo recibido no coincide con el registrado.</span>

  return <section className="json-viewer" aria-label={`JSON de ${nombre}`}>
    <div className="json-toolbar">
      <div className="json-tabs" role="group" aria-label="Vista del JSON">
        <button type="button" aria-pressed={vista === 'formateado'} disabled={!formateable} onClick={() => setVista('formateado')}>Formateado</button>
        <button type="button" aria-pressed={vista === 'original'} onClick={() => setVista('original')}>Original exacto</button>
      </div>
      <div className="json-actions">
        <button type="button" className="button button-outline" onClick={() => {
          navigator.clipboard?.writeText(texto).then(() => setCopiado('si'), () => setCopiado('no'))
        }}><Icon name={copiado === 'si' ? 'check' : 'content_copy'} />{copiado === 'si' ? 'JSON copiado' : 'Copiar JSON'}</button>
        {descargaUrl && <a className="button button-secondary" href={descargaUrl} download={nombre}><Icon name="download" />Descargar JSON</a>}
      </div>
    </div>
    <p className="sr-only" role="status">{copiado === 'si' ? 'JSON copiado al portapapeles' : copiado === 'no' ? 'No se pudo copiar el JSON' : ''}</p>
    <div className="json-meta">
      {verificacion}
      {analizado.grande && <span className="json-integrity"><Icon name="info" />JSON grande: se muestra sin formato para no bloquear el navegador.</span>}
      {analizado.error && <span className="json-integrity json-integrity-fail"><Icon name="error" />El archivo no se pudo analizar como JSON: {analizado.error}</span>}
      {usadas.size > 0 && vista === 'formateado' && <span className="json-integrity"><Icon name="check" />Resaltadas {usadas.size === 1 ? 'la sección usada' : `las ${usadas.size} secciones usadas`} en la respuesta</span>}
    </div>
    {vista === 'formateado' && formateable
      ? <div className="json-tree" role="region" aria-label="JSON formateado" tabIndex={0}>
        <Nodo valor={analizado.valor as Json} clave={null} ruta="" nivel={0} coma={false} usadas={usadas} />
      </div>
      : <pre className="json-original" role="region" aria-label="JSON original exacto" tabIndex={0}>{texto}</pre>}
  </section>
}
