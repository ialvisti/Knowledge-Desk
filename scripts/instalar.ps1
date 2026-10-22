# Instala las dependencias del servidor y de la interfaz y el Chromium de Playwright.
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\instalar.ps1
# Se detiene en el primer comando que falle y solo anuncia éxito si todo terminó bien.
. (Join-Path $PSScriptRoot 'comun.ps1')

Assert-Node
Invoke-Comando 'Servidor: npm ci' (Join-Path $Raiz 'knowledge-desk-server') 'npm.cmd' @('ci')
Invoke-Comando 'Interfaz: npm ci' (Join-Path $Raiz 'knowledge-desk-ui') 'npm.cmd' @('ci')
Invoke-Comando 'Interfaz: Chromium de Playwright' (Join-Path $Raiz 'knowledge-desk-ui') 'npx.cmd' @('playwright', 'install', 'chromium')
Write-Host "`nDependencias instaladas." -ForegroundColor Green
