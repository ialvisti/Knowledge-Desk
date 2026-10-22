import { readFile, stat } from 'node:fs/promises'
import type { Modo } from './config.ts'
import { MAX_PREGUNTA, MIN_PREGUNTA } from './consulta/validate.ts'

// Un ejemplo no debe prometer consultas sobre datos personales, financieros de
// una persona ni sistemas externos (HU06).
const PROHIBIDOS: { patron: RegExp; motivo: string }[] = [
  { patron: /\bmis?\s+(saldo|cuenta bancaria|contraseña|clave|n[uú]mero de cuenta|tarjeta|n[oó]mina|salario|datos personales)\b/i, motivo: 'promete datos personales o financieros' },
  { patron: /\b(dni|c[eé]dula|pasaporte|seguro social|ssn)\b/i, motivo: 'pide un dato de identidad' },
  { patron: /\b(transfiere|transferir dinero|paga(r)? a|deposita|retira mi dinero)\b/i, motivo: 'implica una transacción' },
  { patron: /\b(salesforce|sap|devrev|jira|whatsapp|gmail|outlook)\b/i, motivo: 'menciona un sistema externo' },
]

export function revisarEjemplo(texto: string): string | null {
  const largo = Array.from(texto.trim()).length
  if (largo < MIN_PREGUNTA || largo > MAX_PREGUNTA) return 'no cumple el largo de una pregunta válida'
  return PROHIBIDOS.find(item => item.patron.test(texto))?.motivo ?? null
}

export interface ResultadoEjemplos {
  examples: string[]
  verified: boolean
  note: string | null
  rejected: { text: string; reason: string }[]
}

export type Verificador = (pregunta: string) => Promise<boolean>

// Los ejemplos viven en config/ejemplos.json, uno por modo de corpus, así el
// equipo los cambia sin tocar la recuperación. Solo se muestran los que el
// corpus activo puede sustentar.
export class Ejemplos {
  private readonly archivo: string
  private readonly modo: Modo
  private readonly verificador: Verificador | null
  private cache: { clave: string; resultado: ResultadoEjemplos } | null = null

  constructor(archivo: string, modo: Modo, verificador: Verificador | null) {
    this.archivo = archivo
    this.modo = modo
    this.verificador = verificador
  }

  async obtener(revisionCorpus: number): Promise<ResultadoEjemplos> {
    if (this.modo === 'sin_configurar') return { examples: [], verified: false, note: 'La consulta no está configurada.', rejected: [] }
    let marca = 0
    try { marca = (await stat(this.archivo)).mtimeMs } catch { return { examples: [], verified: false, note: 'No hay archivo de ejemplos configurado.', rejected: [] } }
    const clave = `${revisionCorpus}:${marca}`
    if (this.cache?.clave === clave) return this.cache.resultado

    const datos = JSON.parse(await readFile(this.archivo, 'utf8')) as Partial<Record<Modo, unknown>>
    const candidatos = (Array.isArray(datos[this.modo]) ? datos[this.modo] as unknown[] : []).filter((item): item is string => typeof item === 'string')
    const rechazados: ResultadoEjemplos['rejected'] = []
    const aceptables = candidatos.filter(texto => {
      const motivo = revisarEjemplo(texto)
      if (motivo) rechazados.push({ text: texto, reason: motivo })
      return !motivo
    }).slice(0, 6)

    let resultado: ResultadoEjemplos
    if (!this.verificador) {
      resultado = { examples: aceptables, verified: false, note: 'Ejemplos configurados para este corpus; no se pudieron contrastar con el índice.', rejected: rechazados }
    } else {
      try {
        const sustentados: string[] = []
        for (const texto of aceptables) if (await this.verificador(texto)) sustentados.push(texto)
        resultado = { examples: sustentados, verified: true, note: sustentados.length ? null : 'Ningún ejemplo encuentra evidencia en los documentos indexados.', rejected: rechazados }
      } catch {
        return { examples: [], verified: false, note: 'No se pudieron verificar los ejemplos contra el corpus.', rejected: rechazados }
      }
    }
    this.cache = { clave, resultado }
    return resultado
  }
}
