# Ejecuta todas las comprobaciones: typecheck, lint, pruebas y auditoría del
# servidor; build, lint, auditoría y pruebas Playwright de la interfaz (incluidas
# las E2E contra el stack simulado). Se detiene en el primer fallo. No usa
# credenciales ni servicios reales.
. (Join-Path $PSScriptRoot 'comun.ps1')

$servidor = Join-Path $Raiz 'knowledge-desk-server'
$ui = Join-Path $Raiz 'knowledge-desk-ui'
Assert-Node

Invoke-Comando 'Servidor: typecheck' $servidor 'npm.cmd' @('run', 'typecheck')
Invoke-Comando 'Servidor: lint' $servidor 'npm.cmd' @('run', 'lint')
Invoke-Comando 'Servidor: pruebas' $servidor 'npm.cmd' @('test')
Invoke-Comando 'Servidor: auditoría de dependencias' $servidor 'npm.cmd' @('audit', '--audit-level=moderate')
Invoke-Comando 'Interfaz: build (typecheck + Vite)' $ui 'npm.cmd' @('run', 'build')
Invoke-Comando 'Interfaz: lint' $ui 'npm.cmd' @('run', 'lint')
Invoke-Comando 'Interfaz: auditoría de dependencias' $ui 'npm.cmd' @('audit', '--audit-level=moderate')
Invoke-Comando 'Interfaz: pruebas Playwright (escritorio, móvil y E2E)' $ui 'npm.cmd' @('test')
Write-Host "`nTodas las comprobaciones pasaron." -ForegroundColor Green
