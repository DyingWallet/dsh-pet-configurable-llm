# 回滚 pet-chat preset：删掉标记块；加 -Restore 时从最近的备份恢复。
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\rollback-preset.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\rollback-preset.ps1 -Restore
param(
  [switch]$Restore,
  [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
$target = Join-Path $profileDir 'cordis.patch.yml'
if (-not (Test-Path -LiteralPath $target)) { throw "找不到 profile patch：$target" }

$utf8 = New-Object System.Text.UTF8Encoding($false)
$begin = '# === pet-chat preset BEGIN ==='
$end = '# === pet-chat preset END ==='

if ($Restore) {
  $backup = Get-ChildItem -LiteralPath $profileDir -Filter 'cordis.patch.yml.bak-pet-chat-*' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $backup) { throw '没有找到 pet-chat 的备份文件' }
  Copy-Item -LiteralPath $backup.FullName -Destination $target -Force
  Write-Host "已从备份恢复：$($backup.FullName)"
  Write-Host '请重启 DSH 桌面版。'
  exit 0
}

$content = [System.IO.File]::ReadAllText($target, $utf8)
$start = $content.IndexOf($begin)
if ($start -lt 0) { Write-Host '没有找到 pet-chat 标记块，无需回滚。'; exit 0 }
$finish = $content.IndexOf($end, $start)
if ($finish -lt 0) { throw '标记块缺少 END，拒绝自动删除；请用 -Restore 从备份恢复。' }
$finish += $end.Length
$next = ($content.Substring(0, $start).TrimEnd() + "`r`n" + $content.Substring($finish).TrimStart()).TrimEnd() + "`r`n"
[System.IO.File]::WriteAllText($target, $next, $utf8)
Write-Host '已删除 pet-chat 标记块。请重启 DSH 桌面版。'
