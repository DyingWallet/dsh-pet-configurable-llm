# Start the pet-llm model service.
#
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -Check
#
# Node lookup order: $env:NODE_EXE -> DSH bundled node -> node on PATH.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as
# ANSI, and any non-ASCII byte here turns into a parse error.
param(
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$candidates = @()
if ($env:NODE_EXE) { $candidates += $env:NODE_EXE }
$candidates += 'D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$fromPath = Get-Command node -ErrorAction SilentlyContinue
if ($fromPath) { $candidates += $fromPath.Source }

$node = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $node) {
  throw 'node.exe not found. Set NODE_EXE, or make sure the DSH bundled node exists.'
}

$entry = Join-Path $root 'src\index.mjs'
if (-not (Test-Path -LiteralPath $entry)) { throw "entry not found: $entry" }

$arguments = @($entry)
if ($Check) { $arguments += '--check' }
Write-Host "node: $node"
Write-Host "entry: $entry"
& $node @arguments
exit $LASTEXITCODE
