# Registers the two scheduled tasks that keep the trading stack alive on
# this box (idempotent — re-run after any change to re-register):
#
#   \Dexter\Stack     at logon (+30s): start-stack.ps1 — IB Gateway login
#                     window + dexter gateway in a visible console.
#   \Dexter\Watchdog  at logon, then every 5 min: watchdog.ts, hidden via
#                     run-hidden.vbs (no console flash). Independent of the
#                     gateway process by design — it is the thing that
#                     reports the gateway dead.
#
# Both run as the current interactive user ("run only when logged on"), so
# no password is stored and windows can be shown. Pre-login coverage is the
# healthchecks.io dead-man option (handbook 3.2), not a service.
#
# Remove everything with uninstall-tasks.ps1.

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$userId = "$env:USERDOMAIN\$env:USERNAME"
$bunExe = Join-Path $env:USERPROFILE '.local\bin\bun.exe'
if (-not (Test-Path $bunExe)) { throw "bun.exe not found at $bunExe" }

$settingsCommon = @{
    AllowStartIfOnBatteries    = $true
    DontStopIfGoingOnBatteries = $true
    StartWhenAvailable         = $true
    MultipleInstances          = 'IgnoreNew'
}

# --- \Dexter\Stack -----------------------------------------------------------
$stackTrigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$stackTrigger.Delay = 'PT30S'  # let network + user profile settle first
$stackAction = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSScriptRoot\start-stack.ps1`"" `
    -WorkingDirectory $repoRoot
# PT0S disables the run-time limit: Task Scheduler kills the task's process
# tree at the limit, and that tree must never include the gateway console.
$stackSettings = New-ScheduledTaskSettingsSet @settingsCommon -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskPath '\Dexter' -TaskName 'Stack' `
    -Trigger $stackTrigger -Action $stackAction -Settings $stackSettings -Force | Out-Null
Write-Output 'registered \Dexter\Stack (at logon +30s)'

# --- \Dexter\Watchdog --------------------------------------------------------
# A once-trigger with a repetition interval and no duration repeats every
# 5 min indefinitely FROM INSTALL TIME — including after reboots (an
# at-logon trigger's repetition would only arm at the next logon, leaving
# a silent gap until then). "Run only when logged on" + StartWhenAvailable
# gate it around login screens and missed slots.
$wdTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
$wdAction = New-ScheduledTaskAction `
    -Execute 'wscript.exe' `
    -Argument "`"$PSScriptRoot\run-hidden.vbs`" `"$bunExe`" run scripts/ops/watchdog.ts" `
    -WorkingDirectory $repoRoot
# 10 min limit: a wedged check round (hung socket) gets reaped well before
# the next 5-min instance is skipped a second time.
$wdSettings = New-ScheduledTaskSettingsSet @settingsCommon -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskPath '\Dexter' -TaskName 'Watchdog' `
    -Trigger $wdTrigger -Action $wdAction -Settings $wdSettings -Force | Out-Null
Write-Output 'registered \Dexter\Watchdog (every 5 min, starting now)'

# Kick the watchdog once so state/log exist without waiting for a logon.
Start-ScheduledTask -TaskPath '\Dexter' -TaskName 'Watchdog'
Write-Output 'started \Dexter\Watchdog once'

# --- alert-channel sanity ----------------------------------------------------
$envPath = Join-Path $repoRoot '.env'
$envText = if (Test-Path $envPath) { Get-Content $envPath -Raw } else { '' }
if ($envText -notmatch '(?m)^\s*WATCHDOG_CALLMEBOT_APIKEY\s*=\s*\S') {
    Write-Warning ('WhatsApp alerts are NOT configured yet - the watchdog will log outages but cannot message you. ' +
        'Set WATCHDOG_WHATSAPP_PHONE and WATCHDOG_CALLMEBOT_APIKEY in .env (activation: handbook 3.2), then verify with: ' +
        'bun run scripts/ops/watchdog.ts --test-alert')
}
