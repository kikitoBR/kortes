@echo off
chcp 65001 >nul
title Kortes (local)
cd /d "%~dp0"
echo Desligando o Kortes (os clipes e contas ficam guardados)...
docker compose stop
echo Pronto.
timeout /t 3 >nul
