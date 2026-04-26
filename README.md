# Hermes Playground Dashboard Plugin

Model Playground for quickly comparing the same prompt across multiple configured models.

<img width="1965" height="1159" alt="image" src="https://github.com/user-attachments/assets/a43ddd5c-df26-4a15-aad0-9a9473ac0b9a" />


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
