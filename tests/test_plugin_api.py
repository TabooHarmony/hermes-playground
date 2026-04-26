import asyncio
import importlib.util
import json
import os
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

PLUGIN_PATH = Path(__file__).resolve().parents[1] / "plugin_api.py"


def load_plugin(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    spec = importlib.util.spec_from_file_location("arena_plugin_api_under_test", PLUGIN_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def make_client(mod):
    app = FastAPI()
    app.include_router(mod.router)
    return TestClient(app)


def write_config(home, provider="openrouter", model="openai/gpt-4o-mini"):
    (home / "config.yaml").write_text(
        f"""
model:
  default: {model}
  provider: {provider}
delegation:
  model: deepseek/deepseek-chat
  provider: openrouter
""".strip()
    )


def write_env(home):
    (home / ".env").write_text("OPENROUTER_API_KEY=sk-test\nOPENCODE_GO_API_KEY=og-test\n")


def test_models_lists_presets_and_keyed_providers(tmp_path, monkeypatch):
    write_config(tmp_path)
    write_env(tmp_path)
    mod = load_plugin(tmp_path, monkeypatch)
    client = make_client(mod)

    resp = client.get("/models")

    assert resp.status_code == 200
    data = resp.json()
    assert [p["id"] for p in data["presets"]] == ["openai/gpt-4o-mini", "deepseek/deepseek-chat"]
    providers = {p["name"]: p for p in data["providers"]}
    assert set(providers) == {"opencode-go", "openrouter"}
    assert providers["opencode-go"]["discoverable"] is True
    assert providers["openrouter"]["discoverable"] is True


def test_stream_rejects_empty_prompt(tmp_path, monkeypatch):
    mod = load_plugin(tmp_path, monkeypatch)
    client = make_client(mod)

    resp = client.post("/stream", json={"prompt": "", "models": []})

    assert resp.status_code == 400
    assert resp.json()["detail"] == "prompt is required"


def test_stream_rejects_missing_models(tmp_path, monkeypatch):
    mod = load_plugin(tmp_path, monkeypatch)
    client = make_client(mod)

    resp = client.post("/stream", json={"prompt": "hello", "models": []})

    assert resp.status_code == 400
    assert resp.json()["detail"] == "at least one model is required"


def test_stream_rejects_malformed_models(tmp_path, monkeypatch):
    mod = load_plugin(tmp_path, monkeypatch)
    client = make_client(mod)

    resp = client.post("/stream", json={"prompt": "hello", "models": [{"id": ""}, "bad"]})

    assert resp.status_code == 400
    assert resp.json()["detail"] == "models must include id and provider"


def test_discover_models_opencode_go_uses_static_model_catalog(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("OPENCODE_GO_API_KEY=server-key\n")
    mod = load_plugin(tmp_path, monkeypatch)
    client = make_client(mod)

    resp = client.get("/providers/opencode-go/models")

    assert resp.status_code == 200
    data = resp.json()
    assert data["provider"] == "opencode-go"
    assert "kimi-k2.6" in data["models"]
    assert "deepseek-v4-pro" in data["models"]


def test_discover_models_openrouter_uses_models_endpoint(tmp_path, monkeypatch):
    write_env(tmp_path)
    mod = load_plugin(tmp_path, monkeypatch)

    class FakeResp:
        status = 200
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def json(self):
            return {"data": [{"id": "z-model"}, {"id": "a-model"}, {"bad": True}]}

    class FakeSession:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        def get(self, *args, **kwargs): return FakeResp()

    monkeypatch.setitem(__import__("sys").modules, "aiohttp", type("Aio", (), {"ClientSession": FakeSession, "ClientTimeout": lambda **kw: None}))

    models = asyncio.run(mod._discover_provider_models("openrouter", "https://openrouter.ai/api/v1", "sk-test"))

    assert models == ["a-model", "z-model"]


def test_custom_env_provider_is_discoverable(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("DEEPINFRA_API_KEY=server-key\nDEEPINFRA_BASE_URL=https://api.deepinfra.com/v1\n")
    mod = load_plugin(tmp_path, monkeypatch)
    client = make_client(mod)

    resp = client.get("/models")

    assert resp.status_code == 200
    providers = {p["name"]: p for p in resp.json()["providers"]}
    assert providers["deepinfra"]["discoverable"] is True


def test_ollama_cloud_provider_uses_cloud_api_and_discovery(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("OLLAMA_API_KEY=server-key\n")
    mod = load_plugin(tmp_path, monkeypatch)
    client = make_client(mod)

    resp = client.get("/models")

    assert resp.status_code == 200
    providers = {p["name"]: p for p in resp.json()["providers"]}
    assert providers["ollama"]["base_url"] == "https://ollama.com"
    assert providers["ollama"]["discoverable"] is True


def test_discover_models_ollama_cloud_uses_native_tags_shape(tmp_path, monkeypatch):
    mod = load_plugin(tmp_path, monkeypatch)
    seen = {}

    class FakeResp:
        status = 200
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def json(self):
            return {"models": [{"name": "gpt-oss:120b"}, {"model": "deepseek-v4-flash:cloud"}]}

    class FakeSession:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        def get(self, url, **kwargs):
            seen["url"] = url
            return FakeResp()

    monkeypatch.setitem(__import__("sys").modules, "aiohttp", type("Aio", (), {"ClientSession": FakeSession, "ClientTimeout": lambda **kw: None}))

    models = asyncio.run(mod._discover_provider_models("ollama", "https://ollama.com", "server-key"))

    assert seen["url"] == "https://ollama.com/api/tags"
    assert models == ["deepseek-v4-flash:cloud", "gpt-oss:120b"]


def test_generic_provider_model_discovery_uses_configured_models_endpoint(tmp_path, monkeypatch):
    mod = load_plugin(tmp_path, monkeypatch)
    seen = {}

    class FakeResp:
        status = 200
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def json(self):
            return {"data": [{"id": "b-model"}, {"id": "a-model"}]}

    class FakeSession:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        def get(self, url, **kwargs):
            seen["url"] = url
            return FakeResp()

    monkeypatch.setitem(__import__("sys").modules, "aiohttp", type("Aio", (), {"ClientSession": FakeSession, "ClientTimeout": lambda **kw: None}))

    models = asyncio.run(mod._discover_provider_models("deepinfra", "https://api.deepinfra.com/v1", "server-key"))

    assert seen["url"] == "https://api.deepinfra.com/v1/models"
    assert models == ["a-model", "b-model"]


def test_ollama_native_stream_parses_ndjson_chunks(tmp_path, monkeypatch):
    mod = load_plugin(tmp_path, monkeypatch)
    seen = {}

    class FakeContent:
        async def iter_any(self):
            yield b'{"message":{"content":"Hel"},"done":false}\n'
            yield b'{"message":{"content":"lo"},"done":false}\n'
            yield b'{"done":true,"prompt_eval_count":3,"eval_count":2}\n'

    class FakeResp:
        status = 200
        content = FakeContent()
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None

    class FakeSession:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        def post(self, url, json=None, headers=None):
            seen["url"] = url
            seen["payload"] = json
            return FakeResp()

    fake_aiohttp = type("Aio", (), {"ClientSession": FakeSession, "ClientTimeout": lambda **kw: None})

    async def consume():
        return [event async for event in mod._stream_ollama_native(
            event_id="ollama::gpt-oss:120b",
            model_id="gpt-oss:120b",
            provider="ollama",
            base_url="https://ollama.com",
            api_key="server-key",
            prompt="Hi",
            system="",
            max_tokens=64,
            aiohttp=fake_aiohttp,
        )]

    events = asyncio.run(consume())

    assert seen["url"] == "https://ollama.com/api/chat"
    assert seen["payload"]["options"]["num_predict"] == 64
    assert any('"text": "Hel"' in event for event in events)
    assert any('"text": "lo"' in event for event in events)
    assert any('"tokens_in": 3' in event and '"tokens_out": 2' in event for event in events)


def test_stream_ignores_client_supplied_api_key(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("OPENROUTER_API_KEY=server-key\n")
    mod = load_plugin(tmp_path, monkeypatch)
    seen = {}

    class FakeRequest:
        async def is_disconnected(self):
            return False

    async def fake_stream_one(**kwargs):
        seen.update(kwargs)
        yield 'event: model_done\ndata: {"id":"m","metrics":{}}\n\n'

    monkeypatch.setattr(mod, "_stream_one", fake_stream_one)
    response = asyncio.run(mod.stream_models(
        FakeRequest(),
        {"prompt": "hello", "models": [{"id": "m", "provider": "openrouter", "api_key": "client-key"}]},
    ))

    async def consume():
        return [chunk async for chunk in response.body_iterator]

    chunks = asyncio.run(consume())

    assert chunks == ['event: model_done\ndata: {"id":"m","metrics":{}}\n\n']
    assert seen["api_key"] == "server-key"


def test_stream_generator_stops_when_client_disconnects(tmp_path, monkeypatch):
    mod = load_plugin(tmp_path, monkeypatch)
    cancelled = False

    class FakeRequest:
        calls = 0
        async def is_disconnected(self):
            self.calls += 1
            return self.calls > 1

    async def fake_stream_one(**kwargs):
        nonlocal cancelled
        try:
            yield 'event: model_start\ndata: {"id":"m"}\n\n'
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            cancelled = True
            raise

    monkeypatch.setattr(mod, "_stream_one", fake_stream_one)

    response = asyncio.run(mod.stream_models(
        FakeRequest(),
        {"prompt": "hello", "models": [{"id": "m", "provider": "openrouter"}]},
    ))

    async def consume():
        chunks = []
        async for chunk in response.body_iterator:
            chunks.append(chunk)
        await asyncio.sleep(0)
        return chunks

    chunks = asyncio.run(consume())

    assert chunks == ['event: model_start\ndata: {"id":"m"}\n\n']
    assert cancelled is True
