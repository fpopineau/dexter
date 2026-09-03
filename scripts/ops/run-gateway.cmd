@echo off
rem Visible-console wrapper for the dexter gateway. Keeps `bun run gateway`
rem alive across crashes (10s backoff) so a mid-day exception never silently
rem ends the trading loop. Close the window (or Ctrl+C then Y) to stop —
rem the watchdog will report the gateway down, which is the intended signal.
title Dexter Gateway
cd /d "%~dp0..\.."

set "BUN=%USERPROFILE%\.local\bin\bun.exe"
if not exist "%BUN%" set "BUN=bun"

:loop
"%BUN%" run gateway
echo.
echo [%date% %time%] gateway exited with code %errorlevel% - restarting in 10s (close window to stop)
rem Full path: MSYS/Git-Bash PATHs shadow Windows timeout.exe with GNU timeout.
"%SystemRoot%\System32	imeout.exe" /t 10 /nobreak >nul
goto loop
