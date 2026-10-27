# Stop the pet-brain backend by the port configured in its own config.json.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$port = 8790
try {
  $cfg = Get-Content -LiteralPath (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($cfg.listen.port) { $port = [int]$cfg.listen.port }
} catch { }

$listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -eq 0) {
  Write-Host "pet-brain: nothing listening on $port"
  exit 0
}
foreach ($l in $listeners) {
  try {
    Stop-Process -Id $l.OwningProcess -Force -ErrorAction Stop
    Write-Host "stopped pet-brain on port $port (pid $($l.OwningProcess))"
  } catch {
    Write-Host "FAILED to stop pid $($l.OwningProcess): $($_.Exception.Message)"
    exit 1
  }
}
