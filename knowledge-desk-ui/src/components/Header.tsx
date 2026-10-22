import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation, useSearchParams } from 'react-router-dom'
import { Icon } from './ui'
export function Header() {
  const { pathname } = useLocation()
  const [params, setParams] = useSearchParams()
  const isDocuments = pathname === '/documentos'
  const [open, setOpen] = useState(false)
  const account = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    function outside(event: PointerEvent) {
      if (!account.current?.contains(event.target as Node)) setOpen(false)
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  return <header className="site-header">
    <div className="page-container header-inner">
      <Link to="/" className="brand" onClick={() => setOpen(false)}>Knowledge Desk</Link>
      <nav aria-label="Navegación principal" className="primary-nav">
        <NavLink to="/" end className={({ isActive }) => `nav-link ${isActive || pathname === '/resultados' ? 'active' : ''}`} onClick={() => setOpen(false)}>Consulta</NavLink>
        <NavLink to="/documentos" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} onClick={() => setOpen(false)}>Documentos</NavLink>
      </nav>
      <div className="header-actions">
        {isDocuments && <div className="document-filter">
          <Icon name="search" />
          <input aria-label="Buscar documentos por nombre" placeholder="Buscar..." value={params.get('filtro') ?? ''} onChange={event => {
            const next = new URLSearchParams(params)
            if (event.target.value) next.set('filtro', event.target.value); else next.delete('filtro')
            setParams(next, { replace: true })
          }} />
        </div>}
        <div className="account" ref={account} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
          <button ref={trigger} className="icon-button" aria-label="Sesión de usuario" aria-expanded={open} aria-controls="session-information" onClick={() => setOpen(!open)}><Icon name="account_circle" /></button>
          {open && <div id="session-information" className="account-popover" role="region" aria-label="Información de la sesión">
            <p className="eyebrow mb-3">Tu espacio de consulta</p>
            <h2 className="font-editorial text-2xl mb-2">Sesión de demostración</h2>
            <p>Knowledge Desk consulta el conocimiento indexado. La pantalla Documentos sigue siendo una maqueta y lo que añadas ahí solo permanece hasta recargar la página.</p>
            <div className="account-status"><span className="demo-dot" />Sin cuenta conectada</div>
          </div>}
        </div>
      </div>
    </div>
  </header>
}
