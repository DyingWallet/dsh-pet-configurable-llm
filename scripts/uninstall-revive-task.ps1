# Remove the pet-revive watchdog registered by install-revive-task.ps1.
#
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall-revive-task.ps1
#
# Only the scheduled task is removed; a running pet-brain keeps running.
$installScript = Join-Path $PSScriptRoot 'install-revive-task.ps1'
if (-not (Test-Path -LiteralPath $installScript)) { throw "missing $installScript" }
& $installScript -Remove
exit $LASTEXITCODE
