// Ancla de una ruta JSON (p. ej. details.steps[0]) dentro del visor.
export const anclaRuta = (ruta: string) => `json-${encodeURIComponent(ruta)}`
