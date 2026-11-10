@echo off
rem ==========================================================================
rem  Prepara o Python do projeto. Chamado pelo INICIAR.bat e pelos outros .bat:
rem     call preparar_ambiente.bat
rem  - cria o ambiente virtual .venv na primeira vez
rem  - instala o requirements.txt na primeira vez e sempre que ele mudar
rem  - sem Python no PC, oferece instalar pelo winget
rem  No fim, a variavel PY tem o caminho do python.exe do .venv
rem  (fica vazia se nao houver Python).
rem ==========================================================================
set "PY="
set "RAIZ=%~dp0"
set "VENV_PY=%RAIZ%.venv\Scripts\python.exe"
if exist "%VENV_PY%" goto :dependencias

call :achar_python
if not defined BASE call :instalar_python
if not defined BASE exit /b 1

echo Preparando o ambiente do projeto (.venv) - so na primeira vez...
%BASE% -m venv "%RAIZ%.venv"
if not exist "%VENV_PY%" (
  echo Nao consegui criar o .venv. Usando o Python do sistema.
  set "PY=%BASE_EXE%"
  exit /b 0
)

:dependencias
set "PY=%VENV_PY%"
rem requirements.txt igual ao da ultima instalacao? entao nao ha nada a fazer
fc /b "%RAIZ%requirements.txt" "%RAIZ%.venv\requirements.instalado" >nul 2>nul && exit /b 0

echo.
echo Instalando as bibliotecas do projeto (so na primeira vez, pode levar alguns minutos)...
"%PY%" -m pip install --disable-pip-version-check -r "%RAIZ%requirements.txt"
if errorlevel 1 (
  echo.
  echo Algumas bibliotecas nao instalaram. O programa abre mesmo assim;
  echo na proxima vez que voce abrir, ele tenta de novo.
  echo.
  exit /b 0
)
copy /y "%RAIZ%requirements.txt" "%RAIZ%.venv\requirements.instalado" >nul
echo Bibliotecas instaladas.
echo.
exit /b 0


:achar_python
rem py (Python Launcher) primeiro; depois python, testando de verdade porque o
rem "python" da Microsoft Store e so um atalho que abre a loja
set "BASE="
set "BASE_EXE="
where py >nul 2>nul && py -3 -c "import sys" >nul 2>nul && set "BASE=py -3"
if defined BASE (
  for /f "delims=" %%i in ('py -3 -c "import sys;print(sys.executable)"') do set "BASE_EXE=%%i"
  exit /b 0
)
python -c "import sys" >nul 2>nul && set "BASE=python"
if defined BASE (
  for /f "delims=" %%i in ('python -c "import sys;print(sys.executable)"') do set "BASE_EXE=%%i"
  exit /b 0
)
for /d %%d in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
  if exist "%%~d\python.exe" set "BASE_EXE=%%~d\python.exe"
)
if defined BASE_EXE set BASE="%BASE_EXE%"
exit /b 0


:instalar_python
echo.
echo Python nao encontrado neste computador.
where winget >nul 2>nul || (
  echo Instale o Python 3 em https://www.python.org/downloads/
  echo marcando "Add python.exe to PATH", e abra de novo.
  exit /b 0
)
choice /c SN /m "Instalar o Python 3.12 agora (winget, sem pedir administrador)"
if errorlevel 2 exit /b 0
winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
rem o PATH desta janela nao atualiza sozinho: procura o Python recem-instalado
call :achar_python
exit /b 0
