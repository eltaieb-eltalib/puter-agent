@echo off
setlocal
chcp 65001 >nul

set "LLAMA_SERVER=llama-server.exe"
where %LLAMA_SERVER% >nul 2>nul
if errorlevel 1 (
  echo [ERROR] llama-server.exe was not found in PATH.
  echo Install llama.cpp and add its folder to PATH, or edit LLAMA_SERVER in this file.
  pause
  exit /b 1
)

set "MODEL_PATH=%QWEN_GGUF_PATH%"
if "%MODEL_PATH%"=="" set /p MODEL_PATH=Enter the full path to your qwen-coder-1.5b.gguf file:
if not exist "%MODEL_PATH%" (
  echo [ERROR] Model file not found: "%MODEL_PATH%"
  pause
  exit /b 1
)

echo Starting local Qwen GGUF server at http://127.0.0.1:8080 ...
echo Context: 8192 tokens. Jinja chat template enabled for tool-call parsing.
"%LLAMA_SERVER%" -m "%MODEL_PATH%" --host 127.0.0.1 --port 8080 --alias qwen-coder-1.5b --jinja -c 8192 -t 4 -b 256 -ub 128 -ngl 0

endlocal
