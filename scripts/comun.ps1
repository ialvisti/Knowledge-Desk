# Funciones compartidas por los scripts de Windows de Knowledge Desk.
# - Cada comando nativo (node, npm, npx) se comprueba por su código de salida:
#   PowerShell no lo convierte en error por sí solo, así que sin esto un fallo
#   pasaría desapercibido y el script anunciaría un éxito falso.
# - Los procesos en segundo plano se inician en la misma consola (sin ventanas
#   nuevas) y al terminar se detiene SOLO el árbol del proceso que inició el
#   script, nunca otros procesos de node del equipo.
$ErrorActionPreference = 'Stop'
# Se carga con ". comun.ps1": $Raiz queda disponible en el script que lo carga.
$Raiz = Split-Path -Parent $PSScriptRoot

function Assert-Node {
  $version = (& node --version)
  if ($LASTEXITCODE -ne 0 -or -not $version) { throw 'No se encontró Node.js. Instala Node.js 22.18 o superior (probado con 24.14).' }
  $partes = $version.TrimStart('v').Split('.')
  if ([int]$partes[0] -lt 22 -or ([int]$partes[0] -eq 22 -and [int]$partes[1] -lt 18)) {
    throw "Knowledge Desk necesita Node.js 22.18 o superior (probado con 24.14). Tienes $version."
  }
}

# Ejecuta un comando nativo en una carpeta y lanza un error si no termina con 0.
function Invoke-Comando {
  param(
    [Parameter(Mandatory)][string]$Descripcion,
    [Parameter(Mandatory)][string]$Carpeta,
    [Parameter(Mandatory)][string]$Archivo,
    [string[]]$Argumentos = @()
  )
  Write-Host "`n== $Descripcion" -ForegroundColor Cyan
  Push-Location $Carpeta
  try {
    & $Archivo @Argumentos
    if ($LASTEXITCODE -ne 0) { throw "Falló: $Descripcion (código $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}

# Inicia un proceso en segundo plano en la misma consola y lo devuelve.
function Start-Fondo {
  param(
    [Parameter(Mandatory)][string]$Archivo,
    [Parameter(Mandatory)][string[]]$Argumentos,
    [Parameter(Mandatory)][string]$Carpeta
  )
  $proceso = Start-Process -FilePath $Archivo -ArgumentList $Argumentos -WorkingDirectory $Carpeta -NoNewWindow -PassThru
  # Conservar el handle permite leer ExitCode si el proceso termina antes de tiempo.
  $null = $proceso.Handle
  return $proceso
}

# Espera a que el servidor responda en /api/salud. Si el proceso termina antes
# (puerto ocupado, configuración inválida…), falla con su código de salida.
function Wait-Salud {
  param(
    [Parameter(Mandatory)][string]$Url,
    [Parameter(Mandatory)]$Proceso,
    [int]$Segundos = 60
  )
  $limite = (Get-Date).AddSeconds($Segundos)
  while ((Get-Date) -lt $limite) {
    if ($Proceso.HasExited) { throw "El servidor terminó al arrancar (código $($Proceso.ExitCode)). Revisa el mensaje anterior." }
    try {
      $respuesta = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
      if ($respuesta.StatusCode -eq 200) { return }
    } catch { }
    Start-Sleep -Milliseconds 300
  }
  throw "El servidor no respondió en $Url tras $Segundos s."
}

# Detiene el proceso iniciado por el script y sus procesos hijos (taskkill /T).
function Stop-Arbol {
  param($Proceso)
  if (-not $Proceso -or $Proceso.HasExited) { return }
  & taskkill.exe /PID $Proceso.Id /T /F *> $null
  $Proceso.WaitForExit(5000) | Out-Null
}
