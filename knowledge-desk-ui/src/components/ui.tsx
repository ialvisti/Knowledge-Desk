import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { EstadoDocumento } from '../api/tipos'

export function Icon({ name, className = '', filled = false }: { name: string; className?: string; filled?: boolean }) {
  return <span className={`material-symbols-outlined ${filled ? 'icon-filled' : ''} ${className}`} aria-hidden="true">{name}</span>
}

export function Button({ className = '', variant = 'primary', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'outline' | 'olive'; children: ReactNode }) {
  return <button className={`button button-${variant} ${className}`} {...props}>{children}</button>
}

const ETIQUETAS: Record<EstadoDocumento, string> = {
  indexado: 'Indexado',
  procesando: 'Procesando',
  error: 'Error',
  eliminando: 'Eliminando',
  bloqueado: 'Bloqueado',
  retirado: 'Retirado',
}

export function StatusBadge({ status }: { status: EstadoDocumento }) {
  return <span className={`status-badge status-${status}`}>{ETIQUETAS[status]}</span>
}

export function Nota({ children }: { children: ReactNode }) {
  return <p className="demo-note"><span className="demo-dot" aria-hidden="true" />{children}</p>
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />
}
