Puter Agent - Local Qwen GGUF provider

1) Install llama.cpp for Windows and make sure llama-server.exe is on PATH.
2) Start the server:
   - Double-click scripts\start-qwen-local.bat
   - Paste the full path to your existing GGUF file when prompted.
   Or set QWEN_GGUF_PATH to the full path before running the batch file.
3) Wait until llama.cpp reports that the model is loaded and the server is listening on port 8080.
4) Start Puter Agent and enter:
   /connect llamacpp qwen-coder-1.5b
5) Check the provider using:
   /model

The integration uses http://127.0.0.1:8080/v1 and does not require an API key.
To use another port/base URL, set LLAMACPP_BASE_URL before starting Puter Agent, for example:
   set LLAMACPP_BASE_URL=http://127.0.0.1:8090/v1

Notes:
- Keep the llama.cpp server window open while using Puter Agent.
- This does not download or copy the GGUF model; it uses the file already on your PC.
- The 1.5B model is small. It can answer and generate code, but tool/function calling may be less reliable than larger coding models. If a tool call fails, inspect the response and try a simpler task.
- The batch file uses CPU-only mode (-ngl 0), 4 threads and 4096 context as a conservative starting point for an 8 GB RAM machine. You can adjust these later.
