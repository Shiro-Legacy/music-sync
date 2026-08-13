<#
.SYNOPSIS
  Registers (or removes) a Windows Task Scheduler logon task that starts the
  music-sync server hidden in the background.

.DESCRIPTION
  Installs a task named 'MusicSyncServer' that runs at logon for the current
  user, invoking `npm start --workspace server` from the repository root via a
  hidden PowerShell wrapper (absolute paths throughout, so PATH quirks in the
  task context do not matter).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$taskName = 'MusicSyncServer'

if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -eq $existing) {
    Write-Host "Task '$taskName' is not installed; nothing to do."
    exit 0
  }
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Removed autostart task '$taskName'."
  exit 0
}

# scripts/ -> server/ -> repo root
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $npmCommand) { $npmCommand = Get-Command npm -ErrorAction SilentlyContinue }
if ($null -eq $npmCommand) {
  Write-Error 'npm was not found on PATH. Install Node.js first, then re-run this script.'
  exit 1
}
$npmPath = $npmCommand.Source

$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$inner = "Set-Location -LiteralPath '$repoRoot'; & '$npmPath' start --workspace server"

$action = New-ScheduledTaskAction -Execute $powershellPath `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"$inner`"" `
  -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'music-sync desktop server: indexes the music library and serves it to the iPhone app over the LAN.' `
  -Force | Out-Null

Write-Host "Installed autostart task '$taskName' (runs hidden at logon for $env:USERNAME)."
Write-Host "Repo root: $repoRoot"
Write-Host "Start it now without logging off: Start-ScheduledTask -TaskName $taskName"
Write-Host "Remove it later with: powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Uninstall"
