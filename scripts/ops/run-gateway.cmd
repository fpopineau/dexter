@echo off
rem Visible-console wrapper for the dexter gateway. Keeps `bun run gateway`
rem alive across crashes (10s backoff) so a mid-day exception never silently
rem ends the trading loop. Close the window (or Ctrl+C then Y) to stop —
rem the watchdog will report the gateway down, which is the intended signal.
title Dexter Gateway
cd /d "%~dp0..\.."

rem PATH is the whole reason this wrapper failed until 2026-09-04: the
rem gateway runs through tsx, and tsx.exe CHOOSES ITS RUNTIME FROM PATH.
rem With node present it spawns node (correct). Without node it silently
rem falls back to bun, which cannot load tsx's Node ESM loader and exits
rem with `preload not found ... loader.mjs` — a crash loop that looked
rem like a repo/path problem for two days. A scheduled task inherits a
rem minimal PATH, so node and bun are both pinned here.
set "NODE_DIR=%ProgramFiles%\nodejs"
if not exist "%NODE_DIR%\node.exe" set "NODE_DIR=%LOCALAPPDATA%\Programs\nodejs"
set "BUN_DIR=%USERPROFILE%\.local\bin"
set "PATH=%NODE_DIR%;%BUN_DIR%;%PATH%"

if not exist "%NODE_DIR%\node.exe" (
    echo [run-gateway] FATAL: node.exe not found - edit NODE_DIR in this script
    pause
    exit /b 1
)
if not exist "%BUN_DIR%\bun.exe" (
    echo [run-gateway] FATAL: bun.exe not found at %BUN_DIR%
    pause
    exit /b 1
)

:loop
"%BUN_DIR%\bun.exe" run gateway
echo.
echo [%date% %time%] gateway exited with code %errorlevel% - restarting in 10s (close window to stop)
rem Full path: MSYS/Git-Bash PATHs shadow Windows timeout.exe with GNU timeout.
"%SystemRoot%\System32\timeout.exe" /t 10 /nobreak >nul
goto loop
