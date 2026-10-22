import { useEffect, useRef, type ReactNode } from 'react'

// Diálogo modal nativo: el resto de la página queda inerte, el foco vuelve al
// elemento que lo abrió y Escape lo cierra salvo que una operación esté en curso.
export function Modal({ etiqueta, onClose, bloqueado = false, className = '', children }: {
  etiqueta: string
  onClose: () => void
  bloqueado?: boolean
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialogo = ref.current!
    const previo = document.activeElement as HTMLElement | null
    if (!dialogo.open) dialogo.showModal()
    return () => {
      dialogo.close()
      previo?.focus()
    }
  }, [])
  return <dialog
    ref={ref}
    className={`kd-modal ${className}`}
    aria-label={etiqueta}
    onCancel={event => {
      event.preventDefault()
      if (!bloqueado) onClose()
    }}
    onClick={event => { if (event.target === event.currentTarget && !bloqueado) onClose() }}
  >
    {children}
  </dialog>
}
