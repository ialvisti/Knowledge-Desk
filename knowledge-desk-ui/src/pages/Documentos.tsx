import { useRef, useState, type DragEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button, DemoNote, Icon, StatusBadge } from '../components/ui'
import { formatDocumentDate, normalize } from '../data/demo'
import { useDocuments } from '../state/documents-context'
export function Documentos() {
  const { documents, addFiles } = useDocuments()
  const [params] = useSearchParams()
  const filter = normalize(params.get('filtro') ?? '')
  const visible = documents.filter(doc => normalize(doc.name).includes(filter))
  const input = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [report, setReport] = useState<{ added: number; errors: string[] } | null>(null)
  function receive(files: File[]) { setReport(addFiles(files)) }
  function drop(event: DragEvent) {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    receive(Array.from(event.dataTransfer.files))
  }
  return <main id="contenido" tabIndex={-1} className="page-container documents-page">
    <div className="documents-heading">
      <h1>Documentos de la base de conocimiento</h1>
      <p>Administra y carga los archivos que alimentan las respuestas del sistema.</p>
    </div>
    <div className="documents-grid">
      <section aria-label="Carga de documentos" className="upload-section">
        <div className={`upload-zone ${dragging ? 'is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDragEnter={event => { event.preventDefault(); dragDepth.current++; setDragging(true) }} onDragLeave={event => { event.preventDefault(); if (--dragDepth.current === 0) setDragging(false) }} onDrop={drop}>
          <span className="upload-icon"><Icon name="cloud_upload" /></span>
          <h2>Cargar documento</h2>
          <p>Arrastra archivos aquí o haz clic para explorar.</p>
          <p className="upload-formats" id="upload-formats">PDF, DOCX, TXT (Máx. 50 MB)</p>
          <Button type="button" onClick={() => input.current?.click()}>Explorar archivos</Button>
          <input ref={input} type="file" className="sr-only" tabIndex={-1} aria-label="Seleccionar documentos" aria-describedby="upload-formats" accept=".pdf,.docx,.txt" multiple onChange={event => { receive(Array.from(event.target.files ?? [])); event.target.value = '' }} />
        </div>
        <p className="upload-explanation"><Icon name="info" />Carga simulada. Tus archivos no se envían ni se leen; solo se muestra su nombre en esta sesión.</p>
        {report && <div className="upload-feedback">
          {report.added > 0 && <p role="status" className="upload-success">{report.added === 1 ? '1 documento añadido' : `${report.added} documentos añadidos`} a la demostración.</p>}
          {report.errors.length > 0 && <ul role="alert" className="upload-errors">{report.errors.map((error, index) => <li key={`${error}-${index}`}>{error}</li>)}</ul>}
        </div>}
      </section>
      <section className="document-list-section" aria-label="Documentos disponibles">
        <div className="document-table-wrap">
          <table className="document-table">
            <caption className="sr-only">Documentos de la base de conocimiento</caption>
            <thead><tr><th scope="col">Nombre</th><th scope="col">Fecha de carga</th><th scope="col">Fragmentos</th><th scope="col">Estado</th></tr></thead>
            <tbody>{visible.map(doc => <tr key={doc.id}>
              <td data-label="Nombre"><div className="document-name"><Icon name={doc.status === 'error' ? 'error' : 'description'} className={doc.status === 'error' ? 'text-error' : ''} /><span title={doc.name}>{doc.name}</span></div></td>
              <td data-label="Fecha de carga">{formatDocumentDate(doc.uploadedAt)}</td>
              <td data-label="Fragmentos">{doc.fragments ?? '—'}</td>
              <td data-label="Estado"><StatusBadge status={doc.status} simulated={doc.simulated} /></td>
            </tr>)}</tbody>
          </table>
          {!visible.length && <div role="status" className="documents-empty"><Icon name="search_off" /><p>No hay documentos que coincidan con tu búsqueda.</p><p>Prueba con otro nombre.</p></div>}
        </div>
        <div className="document-list-footer">
          <span role="status">{visible.length} {visible.length === 1 ? 'documento' : 'documentos'}{filter ? ` de ${documents.length}` : ''}</span>
          <DemoNote />
        </div>
      </section>
    </div>
  </main>
}
