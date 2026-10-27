' Inicia o servidor do Copiloto IA em segundo plano (sem janela, sem abrir o navegador).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = pasta
sh.Environment("PROCESS")("SEM_NAVEGADOR") = "1"
sh.Run "cmd /c ""(where python >nul 2>nul && python servidor.py) || py servidor.py""", 0, False
