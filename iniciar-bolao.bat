@echo off
chcp 65001 >nul
title Bolao Copa 2026
cd /d "%~dp0"

echo ============================================
echo   Bolao Copa 2026 - Inicializador
echo ============================================
echo.

REM --- 1. Verifica o Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado. Instale em https://nodejs.org ^(versao 22 ou superior^)
  pause
  exit /b 1
)

REM --- 2. Instala as dependencias na primeira vez
if not exist node_modules (
  echo Instalando dependencias...
  call npm install --no-audit --no-fund
)

REM --- 3. Baixa o Cloudflare Tunnel na primeira vez
if not exist cloudflared.exe (
  echo Baixando Cloudflare Tunnel ^(uma unica vez^)...
  curl -L -o cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
  if errorlevel 1 (
    echo [ERRO] Falha ao baixar o cloudflared. Verifique sua internet.
    pause
    exit /b 1
  )
)

REM --- 4. Sobe o servidor do bolao (so se ainda nao estiver rodando)
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>nul
if errorlevel 1 (
  start "Bolao - Servidor (nao feche)" cmd /k "node backend\server.js"
  timeout /t 3 >nul
) else (
  echo O servidor ja esta rodando na porta 3000 - abrindo somente o tunel...
)

REM --- 5. Abre o tunel publico
echo.
echo ============================================================
echo  O LINK PUBLICO aparecera abaixo, algo como:
echo     https://alguma-coisa.trycloudflare.com
echo.
echo  Copie esse link e mande para os colegas!
echo  ATENCAO: o link muda a cada reinicializacao do tunel.
echo  Mantenha as duas janelas abertas enquanto o bolao estiver no ar.
echo ============================================================
echo.
cloudflared.exe tunnel --url http://localhost:3000
pause
