@echo off
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Copiloto_IA_servidor.vbs" 2>nul
call "%~dp0parar_servidor.bat" nopause
echo Inicio automatico desativado.
pause
