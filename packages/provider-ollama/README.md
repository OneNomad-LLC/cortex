# @onenomad/cortex-provider-ollama

Local LLM provider backed by Ollama's native HTTP API.

Config:

```yaml
llm:
  providers:
    ollama:
      package: "@onenomad/cortex-provider-ollama"
      enabled: true
      config:
        host: "${OLLAMA_HOST}"       # default http://localhost:11434
        defaultModel: "qwen3:14b"    # fallback if a task doesn't specify
        timeoutMs: 120000
```

No secrets required. Ollama is treated as trusted local infrastructure.
Use Tailscale to reach the Windows host remotely.
