# Regenera las capturas finales de verificación visual en docs\verificacion y la
# página comparativa docs\verificacion\comparacion.html (captura frente a referencia).
# Usa el servidor real en modo simulado: no sale a Internet ni usa credenciales.
#   -SoloComparacion  regenera solo comparacion.html a partir de las capturas existentes
param([switch]$SoloComparacion)
. (Join-Path $PSScriptRoot 'comun.ps1')

$ui = Join-Path $Raiz 'knowledge-desk-ui'
Assert-Node
if ($SoloComparacion) {
  Invoke-Comando 'Página comparativa' $ui 'node' @('tests/capturas/comparacion.ts')
} else {
  Invoke-Comando 'Capturas (Playwright, modo simulado)' $ui 'npx.cmd' @('playwright', 'test', '--project=capturas')
}
Write-Host "`nAbre docs\verificacion\comparacion.html para revisar las capturas." -ForegroundColor Green
