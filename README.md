# Hermes Playground

> Side-by-side LLM comparison, streaming in real-time. Pick your fighters, run the same prompt, and watch models compete on speed, cost, and quality.

## What is this?

Playground is a dashboard plugin for [Hermes Agent](https://github.com/NousResearch/hermes-agent) that lets you pit multiple language models against each other in a single run. Same prompt, same system context, different models. Responses stream live. Metrics appear as they finish. You see who is fast, who is cheap, and who actually answers the question.

No more switching tabs between ChatGPT, Claude, and your self-hosted setup. No more guessing which model is worth the API spend. One prompt, one click, instant comparison.

## Why use it?

- **Pick the right model for the job.** Your cheap model might be fine for summaries. Your expensive model might be overkill. Now you know before you ship.
- **Benchmark before you bet.** Run logic puzzles, instruction-following tests, or your own prompts across providers before committing to one.
- **Spot failures fast.** One model hallucinates? Another refuses? See it side-by-side instead of buried in a different chat window.
- **Track real costs.** Per-run token counts and estimated spend, pulled live from OpenRouter pricing.
- **Test the same model across providers.** Run `deepseek-v4-pro` on OpenRouter vs OpenCode Go vs your own endpoint. Same ID, different backend, different results.

## Features

- **Live streaming.** All models stream simultaneously via Server-Sent Events. No polling, no refresh.
- **Smart metrics.** TTFT (time-to-first-token), total latency, input/output tokens, and estimated cost -- compared and color-coded so best values pop.
- **Model discovery.** Browse available models from OpenRouter, NVIDIA, Ollama Cloud, and OpenCode Go without leaving the UI. Custom OpenAI-compatible providers work too.
- **Benchmark prompts.** Built-in prompt pool with logic puzzles, instruction-following challenges, and reasoning tests. Click Random Prompt to roll a new one.
- **Markdown rendering.** Code blocks, lists, headers, and links render cleanly in each response pane.
- **Export runs.** Download the full run as JSON -- prompt, system context, model list, responses, and metrics.
- **Security first.** API keys stay server-side in your `.env`. The browser never sees them, never stores them.

## Install

1. Clone this repo into your Hermes plugins directory:

```bash
cd ~/.hermes/plugins
git clone https://github.com/TabooHarmony/hermes-playground.git playground
```

2. Restart the Hermes dashboard:

```bash
systemctl restart hermes-dashboard.service
```

3. Open your Hermes dashboard and click **Playground** in the sidebar.

4. Configure your providers in `~/.hermes/.env`:

```bash
# Required for OpenRouter (recommended -- enables pricing + discovery)
OPENROUTER_API_KEY=your_key_here

# Optional -- add any providers you want to compare
OPENCODE_GO_API_KEY=your_key_here
OLLAMA_API_KEY=your_key_here
NVIDIA_API_KEY=your_key_here

# Custom OpenAI-compatible provider
FIREWORKS_AI_API_KEY=your_key_here
FIREWORKS_AI_BASE_URL=https://api.fireworks.ai/inference/v1
```

5. Hit **Add Model**, pick a provider, choose or type a model ID, and run.

## Development

```bash
cd ~/.hermes/plugins/arena/dashboard
npm run build
npm run test:frontend
/root/.hermes/hermes-agent/venv/bin/python -m pytest tests -q
```

## Files

- `src/index.js` - dashboard frontend source
- `dist/index.js` - built plugin bundle loaded by Hermes Dashboard
- `plugin_api.py` - FastAPI router for model discovery and SSE streaming
- `tests/test_plugin_api.py` - backend regression tests
- `tests/frontend_smoke.test.js` - frontend smoke test using a tiny SDK harness

## Manual verification

Restart the dashboard service after building:

```bash
systemctl restart hermes-dashboard.service
for i in $(seq 1 12); do
  curl -fsS http://127.0.0.1:9119/api/plugins/arena/health && break
  sleep 3
done
```

Then open the Dashboard, navigate to Playground, and verify:
- Random Prompt fills the prompt field with a benchmark question
- Add Model opens the provider picker and shows discovered models
- Mixed success/failure runs show per-model errors without hiding successful outputs
- Stop marks in-flight panes as aborted
- Metric values color only comparative latency, first-token time, and estimated cost

## Supported providers

| Provider | Discovery | Streaming | Notes |
|---|---|---|---|
| OpenRouter | Live `/models` | OpenAI-compatible | Pricing auto-fetched |
| NVIDIA | Live `/models` | OpenAI-compatible | |
| Ollama Cloud | Live `/api/tags` | Native Ollama API | Requires `OLLAMA_API_KEY` |
| OpenCode Go | Static catalog | OpenAI-compatible | 14 curated models |
| Custom (env-based) | Live `/models` | OpenAI-compatible | Set `NAME_API_KEY` + `NAME_BASE_URL` |

## Notes

- Custom providers use server-side env vars only. The browser does not store or submit API keys.
- Model selections are stored in browser `localStorage` under a stable key. No secrets are stored there.
- Playground intentionally does not persist run history server-side. It is a playground.
