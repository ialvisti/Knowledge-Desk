import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { DocumentStatus } from '../types'
export function Icon({ name, className = '' }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined ${className}`} aria-hidden="true">{name}</span>
}
export function Button({ className = '', variant = 'primary', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary'; children: ReactNode }) {
  return <button className={`button button-${variant} ${className}`} {...props}>{children}</button>
}
export function StatusBadge({ status, simulated }: { status: DocumentStatus; simulated?: boolean }) {
  const labels = { indexed: 'Indexado', processing: 'Procesando', error: 'Error' }
  return <span className={`status-badge status-${status}`} title={simulated ? 'Estado simulado. El contenido del archivo no se ha leído.' : undefined}>
    {labels[status]}{simulated ? ' · demo' : ''}
  </span>
}
export function DemoNote({ children = 'Demostración local · Datos de ejemplo' }: { children?: ReactNode }) {
  return <p className="demo-note"><span className="demo-dot" aria-hidden="true" />{children}</p>
}
export function Spinner() {
  return <span className="spinner" aria-hidden="true" />
}
