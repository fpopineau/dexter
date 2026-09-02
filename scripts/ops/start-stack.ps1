# Idempotent starter for the trading stack. Run at logon by the
# \Dexter\Stack scheduled task (install-tasks.ps1), or by hand anytime —
# it only starts what is not already running, so re-running is always safe.
#
#  1. IB Gateway (GUI). It CANNOT log itself in: the window opens and waits
#     for the operator's password + 2FA (handbook 3.1 — the Sunday ritual).
#     Starting it at logon just removes the "forgot to launch it" failure.
#  2. The dexter gateway, in a VISIBLE console (run-gateway.cmd) so its
#     state is one glance away when at the screen.
param(
    # Version dirs live under here (e.g. 1045\ibgateway.exe); newest wins
    # so an IB Gateway upgrade needs no edit to this script.
    [string]$IbGatewayRoot = 'C:\Local\IBGateway'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Write-Log([string]$msg) {
    Write-Output "[start-stack] $msg"
}

# --- 1. IB Gateway -----------------------------------------------------------
$ib = Get-Process -Name 'ibgateway' -ErrorAction SilentlyContinue
if ($ib) {
    Write-Log "IB Gateway already running (pid $($ib[0].Id))"
} else {
    $exe = Get-ChildItem -Path $IbGatewayRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object { [int]($_.Name -replace '\D', '0') } -Descending |
        ForEach-Object { Join-Path $_.FullName 'ibgateway.exe' } |
        Where-Object { Test-Path $_ } |
        Select-Object -First 1
    if (-not $exe) {
        Write-Log "ERROR: no ibgateway.exe found under $IbGatewayRoot"
    } else {
        Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe)
        Write-Log "started IB Gateway: $exe (complete the login + 2FA in its window)"
    }
}

# --- 2. Dexter gateway console ----------------------------------------------
# Two signatures count as "running": the bun process itself, and the cmd
# wrapper (which exists alone during its 10s crash-restart gap).
$bunUp = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" |
    Where-Object { $_.CommandLine -match 'run gateway\s*$' }
$wrapperUp = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
    Where-Object { $_.CommandLine -match 'run-gateway\.cmd' }
if ($bunUp -or $wrapperUp) {
    Write-Log 'dexter gateway already running'
} else {
    Start-Process -FilePath 'cmd.exe' `
        -ArgumentList '/c', (Join-Path $PSScriptRoot 'run-gateway.cmd') `
        -WorkingDirectory $repoRoot
    Write-Log 'started dexter gateway console'
}
