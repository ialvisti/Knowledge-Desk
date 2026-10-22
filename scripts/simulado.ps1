# MODO SIMULADO (solo demostración y pruebas): servidor real de Knowledge Desk
# contra simuladores locales de ForUsGuide y Pinecone, con los artículos JSON demo
# cargados por la API real. No usa credenciales ni sale a Internet. Nada de lo que
# muestre acredita una integración real, y la interfaz lo indica.
#   -SinSembrar  arranca con el corpus vacío
# Interfaz en http://127.0.0.1:5173. Ctrl+C detiene la interfaz y el stack simulado.
param([switch]$SinSembrar)
. (Join-Path $PSScriptRoot 'comun.ps1')

$servidor = Join-Path $Raiz 'knowledge-desk-server'
$ui = Join-Path $Raiz 'knowledge-desk-ui'
Assert-Node

$argumentos = @('test/support/simulated-stack.ts')
if (-not $SinSembrar) { $argumentos += '--sembrar' }
$proceso = Start-Fondo 'node' $argumentos $servidor
try {
  Wait-Salud 'http://127.0.0.1:8788/api/salud' $proceso
  $env:KD_SERVER_URL = 'http://127.0.0.1:8788'
  Invoke-Comando 'Interfaz: Vite (modo simulado)' $ui 'npm.cmd' @('run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort')
} finally {
  Stop-Arbol $proceso
}
