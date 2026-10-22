import { useNavigate } from 'react-router-dom'
import { SearchForm } from '../components/SearchForm'
import { Nota } from '../components/ui'
import { useEjemplos } from '../hooks/useEjemplos'
import { useServidor } from '../state/servidor'

// Pantalla inicial: estructura del PDF "Consulta — Knowledge Desk".
export function Consulta() {
  const navigate = useNavigate()
  const ejemplos = useEjemplos()
  const { estado } = useServidor()
  const pie = !estado
    ? 'Comprobando la conexión con el índice de conocimiento…'
    : estado.simulado
      ? 'Modo demostración · índice y respuestas simulados en este equipo, sin conexión con servicios reales'
      : estado.consulta.configurada
        ? 'Conectado al índice de conocimiento · Respuestas generadas por el modelo'
        : `La consulta no está configurada en este servidor (${estado.faltan.join(', ') || 'revisa KD_MODO'})`
  return <main id="contenido" tabIndex={-1} className="consultation-page page-container">
    <div className="consultation-content">
      <div>
        <h1>¿Qué necesitas saber?</h1>
        <p className="consultation-description">Busca en el conocimiento indexado para encontrar respuestas rápidas y precisas sobre políticas, procedimientos y guías internas.</p>
      </div>
      <SearchForm />
      <div className="suggestions">
        <h2 className="eyebrow">Ejemplos sugeridos</h2>
        {/* HU06: el clic ejecuta la consulta directamente, por el mismo flujo que Buscar. */}
        {ejemplos.lista.length > 0
          ? <div className="suggestion-list">
            {ejemplos.lista.map(texto => <button key={texto} onClick={() => navigate(`/resultados?${new URLSearchParams({ q: texto })}`)} className="suggestion-chip">{texto}</button>)}
          </div>
          : !ejemplos.cargando && <p className="suggestions-empty">{ejemplos.nota ?? 'Aún no hay ejemplos para el corpus actual.'}</p>}
      </div>
    </div>
    <div className="consultation-footnote"><Nota>{pie}</Nota></div>
  </main>
}
