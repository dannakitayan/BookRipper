@echo off
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

echo Checking Ollama...
curl -s -o nul -w "%%{http_code}" http://127.0.0.1:11434/api/tags > "%TEMP%\bookripper_ollama_check.txt" 2>nul
set /p OLLAMA_STATUS=<"%TEMP%\bookripper_ollama_check.txt"
del "%TEMP%\bookripper_ollama_check.txt" >nul 2>&1

if not "%OLLAMA_STATUS%"=="200" (
    echo Ollama is not responding - starting it...
    start "" /B "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve >nul 2>&1
    timeout /t 3 /nobreak >nul
) else (
    echo Ollama is already running.
)

cd /d "%~dp0Source"
echo Starting BookRipper...
call npm run tauri dev
pause
