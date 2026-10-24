# 启动模型服务（自动找 Node：环境变量 NODE_EXE -> DSH 自带 Node -> PATH）
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -Check
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
  throw '找不到 node.exe。请设置 NODE_EXE，或确认 DSH 自带 Node 路径存在。'
}

$entry = Join-Path $root 'src\index.mjs'
if (-not (Test-Path -LiteralPath $entry)) { throw "找不到入口：$entry" }

$arguments = @($entry)
if ($Check) { $arguments += '--check' }
Write-Host "node: $node"
Write-Host "entry: $entry"
& $node @arguments
exit $LASTEXITCODE
