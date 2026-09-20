@echo off
title Duplinha SNES - Mesen Input Bridge
color 0b
echo =======================================================
echo   DUPLINHA SNES - INICIANDO BRIDGE DO MESEN (PLAYER 2)
echo =======================================================
echo.
python bridge\mesen_bridge.py
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Erro ao iniciar a bridge. Verifique se o Python esta instalado.
    pause
)
