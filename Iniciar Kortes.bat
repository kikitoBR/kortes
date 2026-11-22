@echo off
chcp 65001 >nul
title Kortes (local)
cd /d "%~dp0"

echo Abrindo o Docker...
docker info >nul 2>&1
if errorlevel 1 (
  start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  :esperando_docker
  timeout /t 3 /nobreak >nul
  docker info >nul 2>&1
  if errorlevel 1 goto esperando_docker
)

echo Subindo o Kortes (a primeira vez demora alguns minutos)...
docker compose up -d --build
if errorlevel 1 (
  echo.
  echo Algo deu errado ao subir. Veja as mensagens acima.
  pause
  exit /b 1
)

echo Esperando o site responder...
:esperando_site
timeout /t 3 /nobreak >nul
curl -s -o nul -w "%%{http_code}" http://localhost:3107/api/auth/get-session | findstr /r "^200$" >nul
if errorlevel 1 goto esperando_site

start "" http://localhost:3107
echo.
echo Kortes aberto em http://localhost:3107
echo Para desligar, use "Parar Kortes.bat".
timeout /t 5 >nul
