# 把 pet-chat preset 插入 DSH 桌面版的 profile patch。
#
# 默认只做 dry-run；确认后加 -Apply。
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\apply-preset.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\apply-preset.ps1 -Apply
#
# 回滚：
#   powershell -ExecutionPolicy Bypass -File scripts\rollback-preset.ps1
param(
  [switch]$Apply,
  [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$patchFile = Join-Path $root 'preset\pet-chat.patch.yml'
if (-not (Test-Path -LiteralPath $patchFile)) { throw "找不到 preset：$patchFile" }

$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
$target = Join-Path $profileDir 'cordis.patch.yml'
if (-not (Test-Path -LiteralPath $target)) { throw "找不到 profile patch：$target" }

$utf8 = New-Object System.Text.UTF8Encoding($false)
$content = [System.IO.File]::ReadAllText($target, $utf8)
$begin = '# === pet-chat preset BEGIN ==='
$end = '# === pet-chat preset END ==='

if ($content.Contains($begin)) {
  Write-Host "pet-chat preset 已经存在，不需要重复插入：$target"
  exit 0
}

$preset = [System.IO.File]::ReadAllText($patchFile, $utf8).TrimEnd()
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$target.bak-pet-chat-$stamp"

Write-Host "目标：$target"
Write-Host "备份：$backup"
Write-Host "将插入：$patchFile（$(($preset -split "`n").Count) 行）"

if (-not $Apply) {
  Write-Host ''
  Write-Host '这是 dry-run。确认无误后加 -Apply 执行；执行后需要重启 DSH 桌面版。'
  exit 0
}

Copy-Item -LiteralPath $target -Destination $backup -Force
$next = $content.TrimEnd() + "`r`n`r`n" + $begin + "`r`n" + $preset + "`r`n" + $end + "`r`n"
[System.IO.File]::WriteAllText($target, $next, $utf8)
Write-Host '已写入。请重启 DSH 桌面版，然后运行：'
Write-Host "  node src\index.mjs --check"
