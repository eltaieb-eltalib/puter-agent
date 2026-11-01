Puter Agent - Qwen local context/tool-call startup fix

Replace only:
  scripts/start-qwen-local.bat

Then:
1. Close the old llama-server window.
2. Start this batch file again and enter the full GGUF path if requested.
3. Wait for the server to report that it is listening on 127.0.0.1:8080.
4. In Puter Agent, reconnect:
   /connect llamacpp qwen-coder-1.5b
5. Try a short prompt first: "Say hello in one sentence."

Changes:
- Context increased from 4096 to 8192 to resolve the reported 4355 > 4096 rejection.
- Explicit --jinja enables llama.cpp's Jinja chat-template processing used for OpenAI-style tool calling.
- Batch sizes lowered to 256/128 as a conservative CPU/RAM setting.

Important:
- The "selected model may not support tools" line may be a generic fallback shown after the server rejected the oversized request. First fix the context error and retest.
- If the context error disappears but tool calls still fail, the GGUF must contain a compatible instruct/chat template and the model must reliably emit tool calls. The exact model variant matters; a base completion model may not work as an agent.
- This patch has not been tested against the GGUF on your PC. If 8192 causes memory pressure, try -c 6144.
