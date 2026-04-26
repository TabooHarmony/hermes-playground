"""Arena plugin -- Model Playground backend.

Reads Hermes config to discover models/providers, streams responses
via SSE using direct HTTP calls to each provider.
"""

import asyncio
import json
import os
import re
import time
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import StreamingResponse

router = APIRouter()

_HERMES_HOME = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))


# ── Config loading ────────────────────────────────────────────────────────

def _load_cfg():
    import yaml
    p = _HERMES_HOME / "config.yaml"
    if p.exists():
        with open(p) as f:
            return yaml.safe_load(f) or {}
    return {}


def _load_env():
    env = {}
    p = _HERMES_HOME / ".env"
    if not p.exists():
        return env
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip("\"'")
    return env


# ── Provider metadata ─────────────────────────────────────────────────────

# Hardcoded known LLM providers.  Each entry maps the canonical provider name
# (as used in Hermes config) to its env key and default base URL.
_PROVIDER_MAP = {
    "opencode-go": {
        "label": "OpenCode Go",
        "env_key": "OPENCODE_GO_API_KEY",
        "default_base_url": "https://opencode.ai/zen/go/v1",
        "models_endpoint": "__static__",
        "static_models": [
            "glm-5",
            "glm-5.1",
            "kimi-k2.5",
            "kimi-k2.6",
            "mimo-v2-pro",
            "mimo-v2-omni",
            "mimo-v2.5-pro",
            "mimo-v2.5",
            "minimax-m2.5",
            "minimax-m2.7",
            "qwen3.5-plus",
            "qwen3.6-plus",
            "deepseek-v4-pro",
            "deepseek-v4-flash",
        ],
        "chat_api": "openai",
    },
    "openrouter": {
        "label": "OpenRouter",
        "env_key": "OPENROUTER_API_KEY",
        "default_base_url": "https://openrouter.ai/api/v1",
        "models_endpoint": "/models",
        "chat_api": "openai",
    },
    "openai": {
        "label": "OpenAI",
        "env_key": "OPENAI_API_KEY",
        "default_base_url": "https://api.openai.com/v1",
        "models_endpoint": "/models",
        "chat_api": "openai",
    },
    "anthropic": {
        "label": "Anthropic",
        "env_key": "ANTHROPIC_API_KEY",
        "default_base_url": "https://api.anthropic.com/v1",
    },
    "gemini": {
        "label": "Google Gemini",
        "env_key": "GEMINI_API_KEY",
        "default_base_url": "",
    },
    "groq": {
        "label": "Groq",
        "env_key": "GROQ_API_KEY",
        "default_base_url": "https://api.groq.com/openai/v1",
        "models_endpoint": "/models",
        "chat_api": "openai",
    },
    "nvidia": {
        "label": "NVIDIA",
        "env_key": "NVIDIA_API_KEY",
        "default_base_url": "https://integrate.api.nvidia.com/v1",
        "models_endpoint": "/models",
        "chat_api": "openai",
    },
    "ollama": {
        "label": "Ollama",
        "env_key": "OLLAMA_API_KEY",
        "default_base_url": "https://ollama.com",
        "models_endpoint": "/api/tags",
        "chat_endpoint": "/api/chat",
        "chat_api": "ollama",
    },
}

# Providers that use OAuth / don't expose a raw API key in .env.
# The Arena plugin can't call these, so we skip them.
_OAUTH_PROVIDERS = {"copilot", "nous", "openai-codex"}


def _get_api_key(provider: str, env: dict, cfg: dict) -> str:
    """Resolve the API key for a provider.

    Checks the hardcoded provider map first, then falls back to the
    {PROVIDER}_API_KEY pattern in .env.
    """
    meta = _PROVIDER_MAP.get(provider)
    if meta:
        key = env.get(meta["env_key"], "")
        if key and key != "***":
            return key
    # Fallback: try {PROVIDER}_API_KEY pattern
    env_key = provider.upper().replace("-", "_") + "_API_KEY"
    key = env.get(env_key, "")
    if key and key != "***":
        return key
    return ""


def _get_base_url(provider: str, cfg: dict) -> str:
    """Resolve the base URL for a provider."""
    meta = _PROVIDER_MAP.get(provider)
    if meta and meta.get("default_base_url"):
        return meta["default_base_url"]

    env = _load_env()
    env_key = provider.upper().replace("-", "_") + "_BASE_URL"
    url = env.get(env_key, "")
    if url:
        return url.rstrip("/")

    # Config fallback for opencode-go
    if provider == "opencode-go":
        url = cfg.get("model", {}).get("base_url", "")
        if url:
            return url.rstrip("/")

    return ""


def _provider_has_key(provider: str, env: dict) -> bool:
    """Check if a provider has a usable API key in env."""
    meta = _PROVIDER_MAP.get(provider)
    if meta:
        key = env.get(meta["env_key"], "")
        if key and key != "***":
            return True
    env_key = provider.upper().replace("-", "_") + "_API_KEY"
    key = env.get(env_key, "")
    return bool(key) and key != "***"


def _discover_providers_from_config(cfg: dict) -> set[str]:
    """Scan config.yaml for provider names used in model, delegation, profiles, etc."""
    found = set()

    # Main model
    model_cfg = cfg.get("model", {})
    if model_cfg.get("provider"):
        found.add(model_cfg["provider"])

    # Delegation model
    delegation = cfg.get("delegation", {})
    if isinstance(delegation, dict) and delegation.get("provider"):
        found.add(delegation["provider"])

    # Credential pool strategies (e.g. custom:integrate.api.nvidia.com)
    cps = cfg.get("credential_pool_strategies", {})
    for key in cps:
        if key.startswith("custom:"):
            # Extract provider name from custom:URL
            found.add(key.split(":", 1)[1].split(".")[0])
        elif key not in _OAUTH_PROVIDERS:
            found.add(key)

    # Scan all provider fields recursively
    def scan(obj):
        if isinstance(obj, dict):
            for k, v in obj.items():
                if k == "provider" and isinstance(v, str) and v and v != "auto":
                    found.add(v)
                else:
                    scan(v)
        elif isinstance(obj, list):
            for item in obj:
                scan(item)

    scan(cfg)

    # Filter out oauth providers and internal ones
    found -= _OAUTH_PROVIDERS
    found.discard("auto")
    found.discard("local")
    found.discard("edge")
    found.discard("hindsight")

    return found


def _discover_providers_from_env(env: dict) -> dict:
    """Scan .env for custom OpenAI-compatible providers.

    Only includes entries that have BOTH *_API_KEY and *_BASE_URL.
    This filters out non-LLM services like Exa or Parallel.
    """
    discovered = {}
    for key, val in env.items():
        if not key.endswith("_API_KEY"):
            continue
        if not val or val == "***":
            continue
        raw_name = key[: -len("_API_KEY")].lower().replace("_", "-")
        if raw_name in _PROVIDER_MAP:
            continue
        base_url_key = key[: -len("_API_KEY")] + "_BASE_URL"
        base_url = env.get(base_url_key, "")
        if not base_url:
            continue  # Skip services without a base URL (Exa, Parallel, etc.)
        discovered[raw_name] = {
            "name": raw_name,
            "label": raw_name.replace("-", " ").title(),
            "base_url": base_url,
            "discoverable": True,
        }
    return discovered


# ── Endpoints ─────────────────────────────────────────────────────────────


@router.get("/models")
async def get_models():
    """Return the user's configured models and available providers (no keys exposed)."""
    cfg = _load_cfg()
    env = _load_env()

    models_cfg = cfg.get("model", {})

    presets = []
    # Main model
    if models_cfg.get("default"):
        presets.append({
            "id": models_cfg["default"],
            "provider": models_cfg.get("provider", ""),
            "base_url": _get_base_url(models_cfg.get("provider", ""), cfg),
            "current": True,
        })
    # Delegation model
    delegation = cfg.get("delegation", {})
    if isinstance(delegation, dict) and delegation.get("model"):
        presets.append({
            "id": delegation["model"],
            "provider": delegation.get("provider", ""),
            "base_url": _get_base_url(delegation.get("provider", ""), cfg),
            "current": False,
        })

    # Build available provider list from multiple sources
    available = []
    seen = set()

    # 1. Hardcoded providers with keys in .env
    for name, meta in _PROVIDER_MAP.items():
        if _provider_has_key(name, env):
            seen.add(name)
            available.append({
                "name": name,
                "label": meta["label"],
                "base_url": _get_base_url(name, cfg) or meta.get("default_base_url", ""),
                "discoverable": bool(meta.get("models_endpoint")),
            })

    # 2. Providers referenced in config.yaml
    for name in _discover_providers_from_config(cfg):
        if name in seen:
            continue
        if _provider_has_key(name, env):
            seen.add(name)
            available.append({
                "name": name,
                "label": name.replace("-", " ").title(),
                "base_url": _get_base_url(name, cfg),
                "discoverable": bool((_PROVIDER_MAP.get(name) or {}).get("models_endpoint")),
            })

    # 3. Custom providers from .env (must have both key + base_url)
    for name, meta in _discover_providers_from_env(env).items():
        if name in seen:
            continue
        seen.add(name)
        available.append({
            "name": name,
            "label": meta["label"],
            "base_url": meta["base_url"],
            "discoverable": True,
        })

    return {
        "presets": presets,
        "providers": available,
    }


@router.get("/providers/{provider}/models")
async def discover_provider_models(provider: str):
    """Discover model IDs for providers with compatible model-list endpoints."""
    cfg = _load_cfg()
    env = _load_env()
    base_url = _get_base_url(provider, cfg)
    api_key = _get_api_key(provider, env, cfg)
    if not api_key:
        raise HTTPException(status_code=400, detail=f"missing API key for provider: {provider}")
    if not base_url:
        raise HTTPException(status_code=400, detail=f"no base URL configured for provider: {provider}")
    meta = _PROVIDER_MAP.get(provider) or {}
    if meta and not meta.get("models_endpoint"):
        raise HTTPException(status_code=400, detail="provider does not support model discovery")
    models = await _discover_provider_models(provider, base_url, api_key)
    return {"provider": provider, "models": models}


async def _discover_provider_models(provider: str, base_url: str, api_key: str) -> list[str]:
    """Return sorted model IDs from a provider's model discovery endpoint."""
    meta = _PROVIDER_MAP.get(provider) or {}
    endpoint = meta.get("models_endpoint") if meta else "/models"
    if not endpoint:
        return []
    if endpoint == "__static__":
        static_models = meta.get("static_models") or []
        return sorted(set(str(m) for m in static_models if m), key=str.lower)
    import aiohttp
    url = f"{base_url.rstrip('/')}{endpoint}"
    headers = {"Authorization": f"Bearer {api_key}"}
    if provider == "openrouter":
        headers["HTTP-Referer"] = "https://hermes-agent.nousresearch.com"
        headers["X-OpenRouter-Title"] = "Hermes Arena"
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(url, headers=headers) as resp:
            if resp.status != 200:
                raise HTTPException(status_code=502, detail=f"provider returned HTTP {resp.status}")
            payload = await resp.json()
    raw_models = payload.get("data")
    if raw_models is None:
        raw_models = payload.get("models")
    if raw_models is None and isinstance(payload, list):
        raw_models = payload
    ids = []
    if isinstance(raw_models, list):
        for item in raw_models:
            if isinstance(item, dict):
                model_id = item.get("id") or item.get("name") or item.get("model")
                if model_id:
                    ids.append(str(model_id))
            elif isinstance(item, str):
                ids.append(item)
    return sorted(set(ids), key=str.lower)


@router.post("/stream")
async def stream_models(request: Request, body: dict = Body(...)):
    """Stream responses from multiple models concurrently via SSE.

    Fires events: model_start, token, model_done, model_error.
    Each event has a JSON data payload with the model id.
    """
    prompt = (body.get("prompt") or "").strip()
    system = (body.get("system") or "").strip()
    models = body.get("models", [])
    try:
        max_tokens = int(body.get("max_tokens", 512) or 512)
    except (TypeError, ValueError):
        max_tokens = 512
    max_tokens = max(1, min(max_tokens, 4096))

    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")
    if not models:
        raise HTTPException(status_code=400, detail="at least one model is required")

    valid_models = []
    for m in models:
        if not isinstance(m, dict):
            continue
        model_id = str(m.get("id") or "").strip()
        provider = str(m.get("provider") or "").strip()
        event_key = str(m.get("key") or f"{provider}::{model_id}").strip()
        if model_id and provider:
            valid_models.append({
                "id": model_id,
                "provider": provider,
                "key": event_key,
            })
    if not valid_models:
        raise HTTPException(status_code=400, detail="models must include id and provider")
    models = valid_models

    async def event_stream():
        env = _load_env()
        cfg = _load_cfg()
        queue: asyncio.Queue = asyncio.Queue()
        sentinel = object()

        async def _run_model(m):
            try:
                provider = m.get("provider", "")
                api_key = _get_api_key(provider, env, cfg)
                base_url = _get_base_url(provider, cfg)
                async for event in _stream_one(
                    event_id=m["key"],
                    model_id=m["id"],
                    provider=provider,
                    base_url=base_url,
                    api_key=api_key,
                    prompt=prompt,
                    system=system,
                    max_tokens=max_tokens,
                ):
                    await queue.put(event)
            except Exception as e:
                await queue.put(_error_event(m.get("key", "?"), str(e)))
            finally:
                await queue.put(sentinel)

        tasks = [asyncio.create_task(_run_model(m)) for m in models]
        finished = 0
        while finished < len(tasks):
            if await request.is_disconnected():
                for t in tasks:
                    if not t.done():
                        t.cancel()
                break
            try:
                item = await asyncio.wait_for(queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                continue
            if item is sentinel:
                finished += 1
            else:
                yield item

        # Cleanup
        for t in tasks:
            if not t.done():
                t.cancel()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _stream_one(event_id: str, model_id: str, provider: str, base_url: str, api_key: str,
                      prompt: str, system: str, max_tokens: int):
    """Stream one model's response as SSE events."""
    yield f"event: model_start\ndata: {json.dumps({'id': event_id})}\n\n"

    t_start = time.monotonic()
    t_first_token = None

    try:
        import aiohttp

        if not base_url:
            yield _error_event(event_id, f"No base URL configured for provider: {provider}")
            return
        if not api_key:
            yield _error_event(event_id, f"Missing API key for provider: {provider}")
            return

        meta = _PROVIDER_MAP.get(provider) or {}
        if meta.get("chat_api") == "ollama":
            async for event in _stream_ollama_native(
                event_id=event_id,
                model_id=model_id,
                provider=provider,
                base_url=base_url,
                api_key=api_key,
                prompt=prompt,
                system=system,
                max_tokens=max_tokens,
                aiohttp=aiohttp,
            ):
                yield event
            return

        url = f"{base_url.rstrip('/')}/chat/completions"
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }

        # OpenRouter needs extra headers
        if "openrouter" in base_url.lower():
            headers["HTTP-Referer"] = "https://hermes-agent.nousresearch.com"
            headers["X-OpenRouter-Title"] = "Hermes Arena"

        payload = {
            "model": model_id,
            "messages": messages,
            "stream": True,
            "max_tokens": max_tokens,
        }

        timeout = aiohttp.ClientTimeout(total=120, sock_read=60)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json=payload, headers=headers) as resp:
                if resp.status != 200:
                    err_text = await resp.text()
                    yield _error_event(event_id, f"HTTP {resp.status}")
                    return

                full_text = ""
                reasoning_chars = 0
                t_total_in = 0
                t_total_out = 0
                buffer = ""

                async for chunk in resp.content.iter_any():
                    buffer += chunk.decode("utf-8", errors="replace")
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        line = line.strip()
                        if not line:
                            continue
                        if not line.startswith("data: "):
                            continue
                        data_str = line[6:]
                        if data_str.strip() == "[DONE]":
                            break
                        try:
                            obj = json.loads(data_str)
                        except json.JSONDecodeError:
                            continue

                        choices = obj.get("choices", [])
                        if not choices:
                            continue

                        delta = choices[0].get("delta", {})

                        # Track reasoning content without rendering it in the visible answer.
                        # Some providers stream private reasoning via reasoning_content;
                        # showing it makes short prompts look broken and can leak chain-of-thought.
                        reasoning = delta.get("reasoning_content")
                        if reasoning:
                            reasoning_chars += len(reasoning)

                        # Handle text content
                        text = delta.get("content")
                        if text:
                            if t_first_token is None:
                                t_first_token = time.monotonic()
                            full_text += text
                            t_total_out += len(text.encode("utf-8"))
                            yield _token_event(event_id, text)

                        # Track usage from final chunk
                        usage = obj.get("usage") or {}
                        if usage.get("prompt_tokens"):
                            t_total_in = usage["prompt_tokens"]
                        if usage.get("completion_tokens"):
                            t_total_out = usage["completion_tokens"]

                t_elapsed = time.monotonic() - t_start
                ttft = (t_first_token - t_start) if t_first_token else t_elapsed

                yield _done_event(event_id, {
                    "latency_seconds": round(t_elapsed, 2),
                    "ttft_seconds": round(ttft, 2),
                    "tokens_in": t_total_in,
                    "tokens_out": t_total_out,
                    "characters": len(full_text),
                    "reasoning_characters": reasoning_chars,
                })

    except Exception as e:
        yield _error_event(event_id, str(e))


async def _stream_ollama_native(event_id: str, model_id: str, provider: str, base_url: str, api_key: str,
                                prompt: str, system: str, max_tokens: int, aiohttp):
    """Stream from Ollama's native cloud/local API."""
    t_start = time.monotonic()
    t_first_token = None
    full_text = ""
    t_total_in = 0
    t_total_out = 0
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    meta = _PROVIDER_MAP.get(provider) or {}
    url = f"{base_url.rstrip('/')}{meta.get('chat_endpoint') or '/api/chat'}"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    payload = {
        "model": model_id,
        "messages": messages,
        "stream": True,
        "options": {"num_predict": max_tokens},
    }
    timeout = aiohttp.ClientTimeout(total=120, sock_read=60)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(url, json=payload, headers=headers) as resp:
            if resp.status != 200:
                yield _error_event(event_id, f"HTTP {resp.status}")
                return
            buffer = ""
            async for chunk in resp.content.iter_any():
                buffer += chunk.decode("utf-8", errors="replace")
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    message = obj.get("message") or {}
                    text = message.get("content") or obj.get("response") or ""
                    if text:
                        if t_first_token is None:
                            t_first_token = time.monotonic()
                        full_text += text
                        yield _token_event(event_id, text)
                    if obj.get("prompt_eval_count"):
                        t_total_in = obj["prompt_eval_count"]
                    if obj.get("eval_count"):
                        t_total_out = obj["eval_count"]
    t_elapsed = time.monotonic() - t_start
    ttft = (t_first_token - t_start) if t_first_token else t_elapsed
    yield _done_event(event_id, {
        "latency_seconds": round(t_elapsed, 2),
        "ttft_seconds": round(ttft, 2),
        "tokens_in": t_total_in,
        "tokens_out": t_total_out,
        "characters": len(full_text),
        "reasoning_characters": 0,
    })


def _token_event(model_id: str, text: str) -> str:
    return f"event: token\ndata: {json.dumps({'id': model_id, 'text': text})}\n\n"


def _done_event(model_id: str, metrics: dict) -> str:
    return f"event: model_done\ndata: {json.dumps({'id': model_id, 'metrics': metrics})}\n\n"


def _error_event(model_id: str, error: str) -> str:
    return f"event: model_error\ndata: {json.dumps({'id': model_id, 'error': error})}\n\n"


@router.get("/health")
async def health():
    return {"ok": True, "plugin": "arena"}


@router.get("/pricing")
async def get_pricing():
    """Return per-token pricing for discoverable providers (OpenRouter only for now)."""
    cfg = _load_cfg()
    env = _load_env()
    pricing = {}

    if _provider_has_key("openrouter", env):
        try:
            base_url = _get_base_url("openrouter", cfg)
            api_key = _get_api_key("openrouter", env, cfg)
            import aiohttp
            url = f"{base_url.rstrip('/')}/models"
            headers = {
                "Authorization": f"Bearer {api_key}",
                "HTTP-Referer": "https://hermes-agent.nousresearch.com",
                "X-OpenRouter-Title": "Hermes Arena",
            }
            timeout = aiohttp.ClientTimeout(total=30)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url, headers=headers) as resp:
                    if resp.status == 200:
                        payload = await resp.json()
                        raw_models = payload.get("data", [])
                        for item in raw_models:
                            if isinstance(item, dict) and item.get("id"):
                                p = item.get("pricing", {})
                                pricing[item["id"]] = {
                                    "prompt": float(p.get("prompt", 0) or 0),
                                    "completion": float(p.get("completion", 0) or 0),
                                }
        except Exception as e:
            import logging
            logging.getLogger("arena").warning(f"Failed to fetch OpenRouter pricing: {e}")

    return {"pricing": pricing}
