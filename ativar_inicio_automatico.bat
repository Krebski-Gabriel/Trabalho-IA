@echo off
cd /d "%~dp0"
set "ALVO=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Copiloto_IA_servidor.vbs"
> "%ALVO%" echo CreateObject("WScript.Shell").Run """%~dp0iniciar_servidor_oculto.vbs""", 0, False
if not exist "%ALVO%" (
  echo Nao consegui criar o atalho de inicializacao.
  pause
  exit /b 1
)
echo Pronto! O servidor vai iniciar sozinho sempre que voce ligar o computador.
echo Iniciando agora em segundo plano...
wscript "%~dp0iniciar_servidor_oculto.vbs"
timeout /t 4 >nul
start "" http://localhost:8000/index.html
echo.
echo Para desligar isso depois, rode desativar_inicio_automatico.bat
pause
