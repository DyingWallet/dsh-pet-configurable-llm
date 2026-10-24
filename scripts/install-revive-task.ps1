# Register the pet-revive watchdog: every minute, start pet-brain if DSH is up
# and 8790 is not listening.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-revive-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-revive-task.ps1 -Check
#   powershell -ExecutionPolicy Bypass -File scripts\install-revive-task.ps1 -Remove
#
# Why it is needed: pet-brain exits by itself when DSH has been unreachable for
# 3 x 20s (src/guard.mjs). After a DSH restart the port stays empty and nothing
# else would start it again - start-stack.ps1 only runs at logon. While 8790 is
# silent, DSH's pet-chat requests fail before reaching our degraded reply and
# dsh-pet falls back to the ordinary chat model (the "fake pet" case).
#
# Must run from a normal (non-sandbox) PowerShell: the DSH sandbox gets "access
# denied" from the Task Scheduler.
param(
  [int]$EveryMinutes = 1,
  [string]$TaskName = 'pet-revive',
  [switch]$Check,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$revive = Join-Path $PSScriptRoot 'revive.mjs'
$runHidden = Join-Path $PSScriptRoot 'run-hidden.vbs'
$node = 'D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'

function Get-ExistingTask([string]$Name) {
  try { return Get-ScheduledTask -TaskName $Name -ErrorAction Stop } catch { return $null }
}

function Show-TaskState([string]$Name) {
  $task = Get-ExistingTask $Name
  if ($null -eq $task) { Write-Host ("{0,-12} missing" -f $Name); return $false }
  $info = Get-ScheduledTaskInfo -TaskName $Name -ErrorAction SilentlyContinue
  $repeat = ''
  $repetition = $task.Triggers | Where-Object { $_.Repetition -and $_.Repetition.Interval } | Select-Object -First 1
  if ($repetition) { $repeat = " every=$($repetition.Repetition.Interval) duration='$($repetition.Repetition.Duration)'" }
  Write-Host ("{0,-12} {1,-8} last={2} result={3} next={4}{5}" -f $Name, $task.State, $info.LastRunTime, $info.LastTaskResult, $info.NextRunTime, $repeat)
  return $true
}

if ($Check) {
  $ok = Show-TaskState $TaskName
  foreach ($path in @($revive, $runHidden)) {
    if (-not (Test-Path -LiteralPath $path)) { Write-Host "missing: $path"; $ok = $false }
  }
  $log = Join-Path $root 'logs\revive.log'
  if (Test-Path -LiteralPath $log) { Write-Host ('last revive event: ' + (Get-Content -LiteralPath $log -Encoding UTF8 -Tail 1)) }
  else { Write-Host 'last revive event: (none; nothing has needed reviving yet)' }
  if ($ok) { Write-Host 'revive watchdog ready' } else { Write-Host 'revive watchdog incomplete' }
  exit $(if ($ok) { 0 } else { 1 })
}

if ($Remove) {
  if (Get-ExistingTask $TaskName) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "removed task '$TaskName'"
  }
  else { Write-Host "task '$TaskName' is not present" }
  exit 0
}

if (-not (Test-Path -LiteralPath $revive)) { throw "missing $revive" }
if (-not (Test-Path -LiteralPath $runHidden)) { throw "missing $runHidden" }
if (-not (Test-Path -LiteralPath $node)) { throw "node.exe not found at $node" }
foreach ($path in @($revive, $runHidden, $node)) {
  if ($path -match '\s') { throw "path contains spaces, quoting would break: $path" }
}
if ($EveryMinutes -lt 1 -or $EveryMinutes -gt 60) { throw 'EveryMinutes must be 1-60' }

$wscriptExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $wscriptExe)) { $wscriptExe = 'wscript.exe' }
$action = New-ScheduledTaskAction -Execute $wscriptExe `
  -Argument ('{0} {1} {2}' -f '//nologo', $runHidden, (('{0} {1}' -f $node, $revive))) `
  -WorkingDirectory $root
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId ('{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME) `
  -LogonType Interactive -RunLevel Limited

# schtasks /TR is capped at 261 characters and this action is longer, so the task
# is created with a throwaway action (that is what writes the indefinite
# repetition) and the real action is swapped in through the cmdlets.
schtasks /Create /TN $TaskName /SC MINUTE /MO $EveryMinutes /TR 'cmd.exe /c exit' /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "schtasks /Create failed with exit $LASTEXITCODE" }
Set-ScheduledTask -TaskName $TaskName -Action $action -Settings $settings -Principal $principal | Out-Null

Write-Host ("installed '{0}': every {1} min -> {2}" -f $TaskName, $EveryMinutes, $revive)
Show-TaskState $TaskName | Out-Null
Write-Host 'verify: powershell -ExecutionPolicy Bypass -File scripts\install-revive-task.ps1 -Check'
Write-Host 'remove: powershell -ExecutionPolicy Bypass -File scripts\uninstall-revive-task.ps1'
