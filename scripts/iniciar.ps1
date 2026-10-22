# Arranca Knowledge Desk con la configuración REAL de knowledge-desk-server\.env.
#   -Produccion  compila la interfaz y la sirve desde el propio servidor (un solo origen)
#   (sin flag)   servidor en segundo plano + servidor de desarrollo de Vite
# Si falta configuración, el servidor arranca igual y lo informa: no simula nada.
# Ctrl+C detiene la interfaz y el servidor que inició este script.
param([switch]$Produccion)
. (Join-Path $PSScriptRoot 'comun.ps1')

$servidor = Join-Path $Raiz 'knowledge-desk-server'
$ui = Join-Path $Raiz 'knowledge-desk-ui'
$archivoEnv = Join-Path $servidor '.env'
Assert-Node

if (-not (Test-Path $archivoEnv)) {
  Write-Warning 'No existe knowledge-desk-server\.env: el servidor arrancará sin modo configurado. Copia .env.example a .env y complétalo.'
}

if ($Produccion) {
  Invoke-Comando 'Interfaz: build de producción' $ui 'npm.cmd' @('run', 'build')
  Invoke-Comando 'Servidor (API e interfaz en el mismo origen)' $servidor 'node' @('--env-file-if-exists=.env', 'src/main.ts')
  return
}

# Solo se lee el puerto del .env, para saber dónde comprobar la salud.
$puerto = 8787
if (Test-Path $archivoEnv) {
  $linea = Select-String -Path $archivoEnv -Pattern '^\s*KD_PORT\s*=\s*(\d+)\s*$' | Select-Object -First 1
  if ($linea) { $puerto = [int]$linea.Matches[0].Groups[1].Value }
}

$proceso = Start-Fondo 'node' @('--env-file-if-exists=.env', 'src/main.ts') $servidor
try {
  Wait-Salud "http://127.0.0.1:$puerto/api/salud" $proceso
  $env:KD_SERVER_URL = "http://127.0.0.1:$puerto"
  Invoke-Comando 'Interfaz: Vite (desarrollo)' $ui 'npm.cmd' @('run', 'dev')
} finally {
  Stop-Arbol $proceso
}
