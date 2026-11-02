import { useId, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { motivoPregunta, validarPregunta } from '../api/servicios'
import { ContadorPregunta } from './consulta'
import { Button, Icon } from './ui'

export function SearchForm() {
  const id = useId()
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  function submit(event: FormEvent) {
    event.preventDefault()
    // HU01: vacío o solo espacios no se envía. Tampoco una pregunta fuera del
    // rango de longitud; el servidor repite la validación (HU10).
    if (motivoPregunta(query) === 'vacia') { setError('Escribe una pregunta para comenzar.'); return }
    const problema = validarPregunta(query)
    if (problema) { setError(problema); return }
    navigate(`/resultados?${new URLSearchParams({ q: query.trim() })}`)
  }
  // Sin maxLength: el navegador recortaría en silencio un texto pegado y además
  // cuenta unidades UTF-16, no caracteres como el servidor.
  return <form onSubmit={submit} className="search-form" role="search" noValidate>
    <label className="sr-only" htmlFor={id}>Escribe tu consulta</label>
    <div className={`search-control ${error ? 'search-invalid' : ''}`}>
      <Icon name="search" />
      <input id={id} value={query} onChange={event => { setQuery(event.target.value); setError(null) }} autoComplete="off" placeholder="Escribe tu consulta aquí..." aria-invalid={error !== null}
        aria-describedby={[error ? `${id}-error` : '', query ? `${id}-contador` : ''].filter(Boolean).join(' ') || undefined} />
      <Button type="submit">Buscar</Button>
    </div>
    <ContadorPregunta id={`${id}-contador`} texto={query} />
    {error && <p id={`${id}-error`} role="alert" className="field-error">{error}</p>}
  </form>
}
