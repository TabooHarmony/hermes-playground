# Hermes Arena Dashboard Plugin

Model Playground for comparing the same prompt across multiple configured models.

## Development

```bash
cd ~/.hermes/plugins/arena/dashboard
npm run build
npm run test:frontend
/root/.hermes/hermes-agent/venv/bin/python -m pytest tests -q
```

## Files

- `src/index.js` - dashboard frontend source.
- `dist/index.js` - built plugin bundle loaded by Hermes Dashboard.
- `plugin_api.py` - FastAPI router for model discovery and SSE streaming.
- `tests/test_plugin_api.py` - backend regression tests.
- `tests/frontend_smoke.test.js` - frontend smoke test using a tiny SDK harness.

## Manual verification

1. Restart the dashboard service after building:

```bash
systemctl restart hermes-dashboard.service
for i in $(seq 1 12); do
  curl -fsS http://127.0.0.1:9119/api/plugins/arena/health && break
  sleep 3
done
```

2. Open Dashboard, then Arena.
3. Verify:
   - sample prompt fills prompt/system fields
   - Add Model shows discovery hints
   - OpenRouter model IDs can be typed/selected through the datalist
   - mixed success/failure runs show per-model errors without hiding successful outputs
   - Stop marks in-flight panes as aborted
   - metric values color only comparative latency, first-token time, and estimated cost

## Notes

- OpenRouter, NVIDIA, and OpenAI-compatible custom providers with a `/models` endpoint support live model discovery.
- Ollama uses Ollama Cloud by default (`https://ollama.com`) with `OLLAMA_API_KEY`, `/api/tags` for discovery, and `/api/chat` for streaming.
- Providers without a compatible model-list endpoint remain manual-entry only.
- Custom providers use server-side env vars only: set `NAME_API_KEY` and `NAME_BASE_URL` in `.env`, then add the same provider name in the UI. The browser does not store or submit API keys.
- Model selections and custom provider names are stored in browser `localStorage` with a route-scoped key. No secrets are stored there.
- Arena intentionally does not persist run history or model sets. It is a playground.
