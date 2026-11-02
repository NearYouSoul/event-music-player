@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Event Music Player

rem Переносной Node.js из папки runtime\ (если его скачали) важнее установленного в системе
set "PATH=%~dp0runtime;%PATH%"
set "NODE_VERSION=v22.11.0"

where node >nul 2>nul
if errorlevel 1 call :get_node || goto :fail

if not exist node_modules\express (
  echo Первый запуск: ставлю зависимости, нужен интернет...
  call npm install --omit=dev --no-audit --no-fund || goto :fail
)

start "" http://localhost:8080
node server.js
pause
exit /b

:get_node
echo Node.js не найден. Скачиваю переносную версию %NODE_VERSION% в папку runtime (один раз, ~30 МБ, нужен интернет)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$zip=Join-Path $env:TEMP 'node-portable.zip';" ^
  "Invoke-WebRequest 'https://nodejs.org/dist/%NODE_VERSION%/node-%NODE_VERSION%-win-x64.zip' -OutFile $zip;" ^
  "Expand-Archive $zip -DestinationPath 'runtime-tmp' -Force;" ^
  "Move-Item 'runtime-tmp\node-%NODE_VERSION%-win-x64' 'runtime';" ^
  "Remove-Item 'runtime-tmp',$zip -Recurse -Force"
if errorlevel 1 exit /b 1
where node >nul 2>nul
exit /b %errorlevel%

:fail
echo.
echo Не получилось запуститься. Проверь интернет (нужен только при первом запуске) и запусти start.bat ещё раз.
pause
exit /b 1
