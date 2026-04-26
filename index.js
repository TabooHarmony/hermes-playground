(function () {
  var SDK = window.__HERMES_PLUGIN_SDK__;
  var React = SDK.React;
  var useState = SDK.hooks.useState;
  var useEffect = SDK.hooks.useEffect;
  var useRef = SDK.hooks.useRef;

  var Card = SDK.components.Card;
  var CardContent = SDK.components.CardContent;
  var Badge = SDK.components.Badge;
  var Button = SDK.components.Button;
  var Label = SDK.components.Label;
  var Select = SDK.components.Select;
  var SelectOption = SDK.components.SelectOption;
  var cn = SDK.utils.cn;

  var STORAGE_SCOPE = "arena:playground:";
  var STORAGE_KEY = STORAGE_SCOPE + "models";
  var CUSTOM_PROVIDERS_KEY = STORAGE_SCOPE + "custom_providers";
  var LEGACY_STORAGE_KEY = "arena_models";
  var LEGACY_CUSTOM_PROVIDERS_KEY = "arena_custom_providers";

  function fmtTime(sec) {
    if (sec === null || sec === undefined) return "--";
    if (sec < 1) return Math.round(sec * 1000) + "ms";
    return sec.toFixed(1) + "s";
  }
  function fmtNum(n) {
    if (n === null || n === undefined || n === "") return "--";
    return Number(n).toLocaleString();
  }
  function fmtCost(n) {
    if (n === null || n === undefined || isNaN(n)) return null;
    if (n === 0) return "~$0.0000";
    if (n < 0.0001) return "~$" + (n * 1000000).toFixed(1) + "\u00b5";
    if (n < 0.01) return "~$" + (n * 1000).toFixed(2) + "m";
    return "~$" + n.toFixed(4);
  }
  function safeId(id) { return String(id || "").trim(); }
  function envPrefix(name) { return String(name || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }
  function makeOutput(status) { return { response: "", metrics: null, status: status || "idle", error: null }; }
  function modelKey(model) { return String((model && model.provider) || "") + "::" + String((model && model.id) || ""); }
  function toneClass(tone) {
    if (tone === "good") return "text-green-400";
    if (tone === "mid") return "text-yellow-400";
    if (tone === "bad") return "text-red-400";
    return "text-foreground";
  }

  var TEST_PROMPTS = [
    "Three boxes are labeled APPLES, ORANGES, and MIXED, but every label is wrong. You may draw one fruit from one box. Which box do you draw from, what fruit result tells you, and how do you relabel all boxes? Explain step by step.",
    "Answer in exactly 5 bullet points. Each bullet must have 9 to 13 words. Explain why caching can make debugging harder. Do not use the words fast, slow, easy, or hard.",
    "A recipe takes 40 minutes at sea level. At high altitude, boiling is cooler, but the oven temperature is unchanged. Which parts of the recipe might need adjustment and which probably do not? State assumptions.",
    "Design a 30-minute migration plan for a small web app with zero data loss, one engineer, no staging server, and users in three time zones. Include rollback criteria.",
    "A user asks for a secure password policy. Give practical guidance, but explicitly reject two common bad policies and explain why they backfire.",
    "You have 8 coins, one is counterfeit and heavier. Find it in two weighings.",
    "Given logs with intermittent 502 errors every 17 minutes, propose the top three root-cause hypotheses and the minimum evidence needed to confirm each.",
    "Provide a short proof that the sum of two odd integers is even, then give one concrete numeric example.",
    "Plan an A/B test for two onboarding flows with limited traffic. Define success metric, sample strategy, and stop conditions.",
    "Explain why correlation is not causation using a realistic software metric example, then show one way to test causality."
  ];
  function randomTestPrompt() { return TEST_PROMPTS[Math.floor(Math.random() * TEST_PROMPTS.length)]; }

  function loadSavedModels() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("arena:/arena:models") || localStorage.getItem("arena:/playground:models") || localStorage.getItem("arena:/sessions:models") || localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }
  function saveModels(models) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(models)); } catch (e) {}
  }
  function loadCustomProviders() {
    try {
      var raw = localStorage.getItem(CUSTOM_PROVIDERS_KEY) || localStorage.getItem("arena:/arena:custom_providers") || localStorage.getItem("arena:/playground:custom_providers") || localStorage.getItem("arena:/sessions:custom_providers") || localStorage.getItem(LEGACY_CUSTOM_PROVIDERS_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }
  function saveCustomProviders(list) {
    try { localStorage.setItem(CUSTOM_PROVIDERS_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function lookupPricing(modelId, provider, pricing) {
    if (!pricing || !modelId) return null;
    // Exact match
    if (pricing[modelId]) return pricing[modelId];
    // Try without provider prefix (e.g. "deepseek/deepseek-v4-pro" -> "deepseek-v4-pro")
    var slashIdx = modelId.indexOf("/");
    if (slashIdx !== -1) {
      var noPrefix = modelId.slice(slashIdx + 1);
      if (pricing[noPrefix]) return pricing[noPrefix];
    }
    // Try with provider prefix (e.g. "kimi-k2.6" -> "moonshot-ai/kimi-k2.6" is unknown, but "deepseek-v4-pro" -> "deepseek/deepseek-v4-pro")
    if (provider && slashIdx === -1) {
      var withPrefix = provider + "/" + modelId;
      if (pricing[withPrefix]) return pricing[withPrefix];
    }
    return null;
  }

  function renderMarkdown(text) {
    if (!text) return "";
    var escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    var lines = escaped.split("\n");
    var out = [];
    var inCode = false;
    var codeLines = [];

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.trim().startsWith("```")) {
        if (inCode) {
          out.push('<pre class="bg-black/30 p-2 rounded-md text-[10px] overflow-x-auto my-1"><code>' + codeLines.join("\n") + '</code></pre>');
          codeLines = [];
          inCode = false;
        } else {
          inCode = true;
        }
        continue;
      }
      if (inCode) { codeLines.push(line); continue; }

      line = line
        .replace(/^### (.*)/, '<h3 class="text-sm font-semibold mt-2 mb-1">$1</h3>')
        .replace(/^## (.*)/, '<h2 class="text-base font-semibold mt-3 mb-1">$1</h2>')
        .replace(/^# (.*)/, '<h1 class="text-lg font-semibold mt-3 mb-1">$1</h1>')
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(?!\*)(.*?)\*/g, "<em>$1</em>")
        .replace(/`([^`]+)`/g, '<code class="bg-foreground/10 px-1 rounded text-[10px]">$1</code>')
        .replace(/^- (.*)/, '<li class="ml-3 list-disc">$1</li>')
        .replace(/^\d+\. (.*)/, '<li class="ml-3 list-decimal">$1</li>')
        .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" class="text-primary underline">$1</a>');
      out.push(line);
    }
    if (inCode && codeLines.length) {
      out.push('<pre class="bg-black/30 p-2 rounded-md text-[10px] overflow-x-auto my-1"><code>' + codeLines.join("\n") + '</code></pre>');
    }
    return out.join("<br>");
  }

  function StatusPill(props) {
    var status = props.status || "idle";
    var colors = { idle: "bg-muted", queued: "bg-muted", streaming: "bg-blue-500", done: "bg-green-500", error: "bg-red-500", aborted: "bg-yellow-500" };
    var label = status === "streaming" ? "running" : status;
    return React.createElement("span", { className: "inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground" },
      React.createElement("span", { className: cn("inline-block w-1.5 h-1.5 rounded-full", colors[status] || "bg-muted") }), label);
  }

  function ModelPane(props) {
    var model = props.model, out = props.out || makeOutput(), onCopy = props.onCopy, onRemove = props.onRemove, running = props.running, pricing = props.pricing || {}, getMetricTone = props.getMetricTone || function () { return null; };
    var showPlaceholder = !out.response && (out.status === "idle" || out.status === "queued");
    var placeholder = out.status === "queued" ? "Queued for this run..." : "Ready to run. Start the run to measure response quality, speed, tokens, and estimated cost.";
    var cost = null;
    var p = lookupPricing(model.id, model.provider, pricing);
    if (out.metrics && p) {
      var est = (out.metrics.tokens_in || 0) * (p.prompt || 0) + (out.metrics.tokens_out || 0) * (p.completion || 0);
      cost = fmtCost(est);
    }
    return React.createElement(Card, null,
      React.createElement("div", { className: "flex items-center justify-between gap-2 px-4 py-3 border-b border-border" },
        React.createElement("div", { className: "min-w-0" },
          React.createElement("div", { className: "flex items-center gap-2 min-w-0" },
            React.createElement("strong", { className: "truncate text-sm text-foreground", title: model.id }, model.id)),
          React.createElement("div", { className: "text-[10px] text-muted-foreground truncate", title: model.provider }, model.provider || "unknown provider")),
        React.createElement("div", { className: "flex items-center gap-2" },
          React.createElement(StatusPill, { status: out.status }),
          React.createElement(Button, { variant: "outline", size: "sm", className: "h-7 px-2 text-[10px]", onClick: onCopy, disabled: !out.response }, "Copy"),
          React.createElement(Button, { variant: "outline", size: "sm", className: "h-7 px-2 text-[10px]", onClick: onRemove, disabled: running, title: "Remove model" }, "Remove"))),
      React.createElement("div", { className: "min-h-[240px] max-h-[60vh] overflow-auto m-3 p-3 whitespace-pre-wrap font-mono-ui text-xs leading-relaxed border border-border bg-background/40 rounded-md normal-case" },
        showPlaceholder ? React.createElement("span", { className: "text-muted-foreground italic" }, placeholder) : null,
        out.status === "streaming" && !out.response ? React.createElement("span", { className: "text-muted-foreground italic" }, "Waiting for first token...") : null,
        out.status === "error" ? React.createElement("div", { className: "text-red-500 whitespace-pre-wrap" }, "Error: " + (out.error || "unknown error")) : null,
        out.status === "aborted" ? React.createElement("div", { className: "text-yellow-500" }, "Run stopped by user.") : null,
        out.response ? React.createElement("div", { dangerouslySetInnerHTML: { __html: renderMarkdown(out.response) } }) : null,
        out.status === "streaming" ? React.createElement("span", { className: "animate-pulse ml-0.5 text-muted-foreground" }, "\u258c") : null),
      React.createElement("div", { className: "grid grid-cols-2 gap-x-4 gap-y-1 px-3 py-2 border-t border-border text-xs text-muted-foreground" },
        React.createElement("span", null, "First token: ", React.createElement("b", { className: cn("font-mono-ui", toneClass(getMetricTone(modelKey(model), "ttft_seconds"))) }, fmtTime(out.metrics && out.metrics.ttft_seconds))),
        React.createElement("span", null, "Latency: ", React.createElement("b", { className: cn("font-mono-ui", toneClass(getMetricTone(modelKey(model), "latency_seconds"))) }, fmtTime(out.metrics && out.metrics.latency_seconds))),
        React.createElement("span", null, "Input tokens: ", React.createElement("b", { className: "text-foreground font-mono-ui" }, fmtNum(out.metrics && out.metrics.tokens_in))),
        React.createElement("span", null, "Output tokens: ", React.createElement("b", { className: "text-foreground font-mono-ui" }, fmtNum(out.metrics && out.metrics.tokens_out))),
        cost ? React.createElement("span", { className: cn("col-span-2 mt-0.5", toneClass(getMetricTone(modelKey(model), "cost"))) }, "Cost: ", React.createElement("b", { className: "font-mono-ui" }, cost)) : null));
  }

  function AddModelDialog(props) {
    var open = props.open, onClose = props.onClose, onAdd = props.onAdd, onAddCustomProvider = props.onAddCustomProvider, providers = props.providers || [], existing = props.existing || [];
    var sp = useState(providers[0] ? providers[0].name : ""), selectedProvider = sp[0], setSelectedProvider = sp[1];
    var mn = useState(""), modelName = mn[0], setModelName = mn[1];
    var err = useState(""), error = err[0], setError = err[1];
    var dm = useState([]), discoveredModels = dm[0], setDiscoveredModels = dm[1];
    var dl = useState(false), discovering = dl[0], setDiscovering = dl[1];
    var scf = useState(false), showCustomForm = scf[0], setShowCustomForm = scf[1];
    var scn = useState(""), customName = scn[0], setCustomName = scn[1];

    useEffect(function () { if (!selectedProvider && providers[0]) setSelectedProvider(providers[0].name); }, [providers.length]);
    useEffect(function () {
      var activeProvider = selectedProvider || (providers[0] && providers[0].name);
      if (!open || !activeProvider) return;
      var providerInfo = providers.find(function (p) { return p.name === activeProvider; });
      setDiscoveredModels([]);
      if (!providerInfo || !providerInfo.discoverable) { setDiscovering(false); return; }
      setDiscovering(true);
      SDK.fetchJSON("/api/plugins/arena/providers/" + encodeURIComponent(activeProvider) + "/models")
        .then(function (data) { setDiscoveredModels(data.models || []); })
        .catch(function (err) { console.warn("Arena: model discovery failed", err); })
        .finally(function () { setDiscovering(false); });
    }, [open, selectedProvider]);
    if (!open) return null;
    var provider = providers.find(function (p) { return p.name === (selectedProvider || (providers[0] && providers[0].name)); });
    var customEnvPrefix = envPrefix(customName || "deepinfra");
    function modelPlaceholder() {
      if (discovering) return "Discovering models...";
      if (provider && provider.discoverable) return "Choose from discovered models, or type one manually";
      if (provider && provider.name === "ollama") return "e.g. llama3.1:latest";
      if (provider && provider.name === "opencode-go") return "e.g. deepseek-v4-pro";
      if (provider && provider.name === "nvidia") return "e.g. nvidia/llama-3.1-nemotron-ultra-253b-v1";
      return "Provider model id";
    }
    function submit() {
      var id = safeId(modelName);
      if (!selectedProvider && provider) setSelectedProvider(provider.name);
      if (!selectedProvider && !provider) return setError("Choose a provider first.");
      if (!id) return setError("Enter a model id.");
      var providerName = selectedProvider || provider.name;
      if (existing.indexOf(providerName + "::" + id) !== -1) return setError("That provider/model pair is already in the arena.");
      onAdd({ id: id, provider: providerName, base_url: provider ? provider.base_url : "", current: false });
      setModelName(""); setError(""); onClose();
    }
    function addCustomProvider() {
      var raw = customName.trim();
      var name = raw.toLowerCase().replace(/\s+/g, "-");
      if (!name) return setError("Enter a provider name.");
      onAddCustomProvider({ name: name, label: raw, discoverable: false, custom: true });
      setShowCustomForm(false); setCustomName(""); setError("");
    }
    return React.createElement("div", { className: "fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4", onClick: onClose },
      React.createElement("div", { className: "w-full max-w-md border border-border bg-card shadow-2xl p-4 rounded-lg", onClick: function (e) { e.stopPropagation(); } },
        React.createElement("div", { className: "flex items-start justify-between gap-3 mb-4" },
          React.createElement("div", null,
            React.createElement("h3", { className: "font-medium text-base text-foreground" }, "Add model"),
            React.createElement("p", { className: "text-xs text-muted-foreground mt-1" }, "Pick a provider, then choose or type a model id.")),
          React.createElement(Button, { variant: "ghost", size: "sm", onClick: onClose }, "Close")),
        providers.length === 0 && !showCustomForm ? React.createElement("div", { className: "border border-dashed border-border rounded-md p-4 text-center text-sm text-muted-foreground mb-3" }, "No providers found. Add a custom provider to continue.") : null,
        React.createElement("div", { className: "flex flex-wrap gap-1.5 mb-3" },
          providers.map(function (p) {
            var active = (selectedProvider || (providers[0] && providers[0].name)) === p.name;
            return React.createElement(Button, { key: p.name, variant: active ? "default" : "outline", size: "sm", className: "h-6 px-2 text-[10px]", onClick: function () { setSelectedProvider(p.name); setModelName(""); setError(""); setShowCustomForm(false); } }, p.label);
          }),
          React.createElement(Button, { variant: showCustomForm ? "default" : "outline", size: "sm", className: "h-6 px-2 text-[10px]", onClick: function () { setShowCustomForm(!showCustomForm); setError(""); }, title: "Add custom provider" }, "Custom provider")),
        showCustomForm ? React.createElement("div", { className: "w-full mb-3 p-2 border border-border rounded-md" },
          React.createElement("div", { className: "text-xs text-muted-foreground mb-2" }, "Custom providers use server-side env vars only."),
          React.createElement("input", { type: "text", value: customName, onChange: function (e) { setCustomName(e.target.value); setError(""); }, placeholder: "Provider name (e.g. deepinfra)", className: "w-full mb-2 px-3 py-2 text-sm border border-border bg-background/40 rounded-md text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30 normal-case" }),
          React.createElement("div", { className: "text-[10px] text-muted-foreground normal-case mb-2 font-mono-ui" }, "Set ", customEnvPrefix, "_API_KEY and ", customEnvPrefix, "_BASE_URL in .env"),
          React.createElement("div", { className: "flex justify-end gap-2" },
            React.createElement(Button, { variant: "outline", size: "sm", onClick: function () { setShowCustomForm(false); } }, "Cancel"),
            React.createElement(Button, { size: "sm", onClick: addCustomProvider }, "Add provider"))) : null,
        !showCustomForm ? React.createElement(React.Fragment, null,
          React.createElement(Label, { className: "text-xs mb-1 block text-foreground" }, "Model ID"),
          discoveredModels.length > 0 ? React.createElement(React.Fragment, null,
            (function () {
              var opts = discoveredModels.map(function (id) { return React.createElement(SelectOption, { key: id, value: id }, id); });
              opts.push(React.createElement(SelectOption, { value: "__custom__" }, "Custom (type manually)..."));
              return React.createElement(Select, { value: modelName || "__custom__", onValueChange: function (v) { setModelName(v === "__custom__" ? "" : v); setError(""); }, className: "w-full mb-2 text-sm" }, opts);
            })(),
            (modelName === "" || discoveredModels.indexOf(modelName) === -1) ? React.createElement("input", { type: "text", value: modelName, onChange: function (e) { setModelName(e.target.value); setError(""); }, onKeyDown: function (e) { if (e.key === "Enter") submit(); if (e.key === "Escape") onClose(); }, placeholder: "Type a model id manually...", className: "w-full mb-2 px-3 py-2 text-sm border border-border bg-background/40 rounded-md text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30 normal-case" }) : null) : null,
          discoveredModels.length === 0 ? React.createElement("input", { list: "arena-discovered-models", type: "text", value: modelName, onChange: function (e) { setModelName(e.target.value); setError(""); }, onKeyDown: function (e) { if (e.key === "Enter") submit(); if (e.key === "Escape") onClose(); }, placeholder: modelPlaceholder(), className: "w-full mb-2 px-3 py-2 text-sm border border-border bg-background/40 rounded-md text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30 normal-case" }) : null,
          React.createElement("datalist", { id: "arena-discovered-models" }, discoveredModels.map(function (id) { return React.createElement("option", { key: id, value: id }); })),
          error ? React.createElement("div", { className: "text-xs text-red-500 mb-3" }, error) : React.createElement("div", { className: "text-xs text-muted-foreground mb-3" }, discovering ? "Loading model list..." : (discoveredModels.length ? discoveredModels.length + " models found." : "Type the provider's canonical model id.")),
          React.createElement("div", { className: "flex justify-end gap-2" },
            React.createElement(Button, { variant: "outline", size: "sm", onClick: onClose }, "Cancel"),
            React.createElement(Button, { size: "sm", onClick: submit, disabled: providers.length === 0 }, "Add model"))) : null));
  }

  function ArenaPage() {
    var s1 = useState(randomTestPrompt()), prompt = s1[0], setPrompt = s1[1];
    var s2 = useState(""), system = s2[0], setSystem = s2[1];
    var sm = useState([]), models = sm[0], setModels = sm[1];
    var sp = useState([]), availableProviders = sp[0], setAvailableProviders = sp[1];
    var scp = useState([]), customProviders = scp[0], setCustomProviders = scp[1];
    var so = useState({}), outputs = so[0], setOutputs = so[1];
    var sr = useState(false), running = sr[0], setRunning = sr[1];
    var sd = useState(false), showAddDialog = sd[0], setShowAddDialog = sd[1];
    var se = useState(""), pageError = se[0], setPageError = se[1];
    var pr = useState({}), pricing = pr[0], setPricing = pr[1];
    var abortRef = useRef(null);

    useEffect(function () {
      var saved = loadSavedModels();
      if (saved.length > 0) {
        setModels(saved);
        var init = {}; saved.forEach(function (m) { init[modelKey(m)] = makeOutput(); }); setOutputs(init);
        // Still fetch providers and pricing
        SDK.fetchJSON("/api/plugins/arena/models").then(function (data) {
          setAvailableProviders(data.providers || []);
        }).catch(function (err) { console.error("Arena: failed to load providers", err); });
      } else {
        SDK.fetchJSON("/api/plugins/arena/models").then(function (data) {
          var presets = (data.presets || []).filter(function (p) { return p && p.id; });
          var current = presets.find(function (p) { return p.current; });
          var defaults = current ? [current] : (presets.length > 0 ? [presets[0]] : []);
          setModels(defaults);
          var init = {}; defaults.forEach(function (m) { init[modelKey(m)] = makeOutput(); }); setOutputs(init);
          setAvailableProviders(data.providers || []);
          if (defaults.length) saveModels(defaults);
        }).catch(function (err) { setPageError("Failed to load configuration: " + (err.message || err)); console.error("Arena: failed to load models", err); });
      }

      setCustomProviders(loadCustomProviders());

      SDK.fetchJSON("/api/plugins/arena/pricing")
        .then(function (data) { setPricing(data.pricing || {}); })
        .catch(function (err) { console.warn("Arena: pricing fetch failed", err); });

      return function () { if (abortRef.current) abortRef.current.abort(); };
    }, []);

    var allProviders = availableProviders.concat(customProviders);

    function removeModel(key) {
      if (running) return;
      var nextModels = models.filter(function (m) { return modelKey(m) !== key; });
      setModels(nextModels);
      setOutputs(function (prev) { var next = Object.assign({}, prev); delete next[key]; return next; });
      saveModels(nextModels);
    }
    function addCustomModel(m) {
      var key = modelKey(m);
      if (models.some(function (x) { return modelKey(x) === key; })) return;
      var nextModels = models.concat([m]);
      setModels(nextModels);
      setOutputs(function (prev) { var n = Object.assign({}, prev); n[key] = makeOutput(); return n; });
      saveModels(nextModels);
    }
    function addCustomProvider(cp) {
      var list = loadCustomProviders();
      if (!list.some(function (p) { return p.name === cp.name; })) {
        list.push(cp);
        saveCustomProviders(list);
        setCustomProviders(list);
      }
    }
    function copyModelOutput(key) {
      var out = outputs[key]; if (!out || !out.response) return;
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(out.response).catch(function () {});
    }
    function exportRun() {
      var payload = { exported_at: new Date().toISOString(), prompt: prompt, system: system || null, max_tokens: 2048, models: models, outputs: outputs };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob); var a = document.createElement("a");
      a.href = url; a.download = "arena-run-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json"; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    }
    function resetOutputs(status) { var init = {}; models.forEach(function (m) { init[modelKey(m)] = makeOutput(status); }); setOutputs(init); }
    function handleStop() {
      if (abortRef.current) abortRef.current.abort();
      setRunning(false);
      setOutputs(function (prev) { var next = {}; Object.keys(prev).forEach(function (id) { var o = prev[id]; next[id] = o.status === "streaming" || o.status === "queued" ? { response: o.response || "", metrics: o.metrics, status: "aborted", error: null } : o; }); return next; });
    }
    function parseSSE(buffer, onEvent) {
      var boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        var raw = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        var eventType = "message"; var dataLines = [];
        raw.split(/\r?\n/).forEach(function (line) { if (line.indexOf("event:") === 0) eventType = line.slice(6).trim(); else if (line.indexOf("data:") === 0) dataLines.push(line.slice(5).trimStart()); });
        if (dataLines.length) onEvent(eventType, dataLines.join("\n"));
      }
      return buffer;
    }
    function handleRun() {
      var cleanPrompt = prompt.trim();
      if (!cleanPrompt) return setPageError("Enter a prompt before running.");
      if (!models.length) return setPageError("Add at least one model before running.");
      if (running) return;
      setPageError(""); setRunning(true);
      var runModels = models.slice(); var init = {}; runModels.forEach(function (m) { init[modelKey(m)] = makeOutput("queued"); }); setOutputs(init);
      var abortController = new AbortController(); abortRef.current = abortController;
      fetch("/api/plugins/arena/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: cleanPrompt, system: system.trim() || undefined, max_tokens: 2048, models: runModels.map(function (m) {
        return { id: m.id, provider: m.provider, key: modelKey(m) };
      }) }), signal: abortController.signal })
      .then(function (resp) { if (!resp.ok || !resp.body) return resp.text().then(function (txt) { throw new Error(txt || ("HTTP " + resp.status)); });
        var reader = resp.body.getReader(); var decoder = new TextDecoder(); var buffer = "";
        function applyEvent(eventType, dataLine) {
          var data; try { data = JSON.parse(dataLine); } catch (e) { return; }
          var eventKey = data.id; if (!eventKey) return;
          setOutputs(function (prev) { var cur = prev[eventKey] || makeOutput(); var next = Object.assign({}, prev);
            if (eventType === "model_start") next[eventKey] = { response: cur.response || "", metrics: null, status: "streaming", error: null };
            else if (eventType === "token") next[eventKey] = { response: (cur.response || "") + (data.text || ""), metrics: cur.metrics, status: "streaming", error: null };
            else if (eventType === "model_done") next[eventKey] = { response: cur.response || "", metrics: data.metrics || null, status: "done", error: null };
            else if (eventType === "model_error") next[eventKey] = { response: cur.response || "", metrics: cur.metrics, status: "error", error: data.error || "unknown" };
            return next; });
        }
        function read() { return reader.read().then(function (result) { if (result.done) return; buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, "\n"); buffer = parseSSE(buffer, applyEvent); return read(); }); }
        return read().then(function () { setOutputs(function (prev) { var next = Object.assign({}, prev); runModels.forEach(function (m) { var o = next[modelKey(m)]; if (o && (o.status === "streaming" || o.status === "queued")) next[modelKey(m)] = { response: o.response || "", metrics: o.metrics, status: "error", error: "stream ended before completion" }; }); return next; }); });
      }).catch(function (err) { if (err.name === "AbortError") return; setPageError("Run failed: " + (err.message || err)); setOutputs(function (prev) { var next = Object.assign({}, prev); runModels.forEach(function (m) { var o = next[modelKey(m)] || makeOutput(); if (o.status === "streaming" || o.status === "queued") next[modelKey(m)] = { response: o.response || "", metrics: o.metrics, status: "error", error: err.message || String(err) }; }); return next; }); console.error("Arena run error:", err); })
      .finally(function () { setRunning(false); abortRef.current = null; });
    }

    var anyOutput = Object.values(outputs).some(function (o) { return o.response || (o.status && o.status !== "idle"); });
    function metricValue(model, metric) {
      var out = outputs[modelKey(model)];
      if (!out || !out.metrics) return null;
      if (metric === "cost") {
        var p = lookupPricing(model.id, model.provider, pricing);
        if (!p) return null;
        return (out.metrics.tokens_in || 0) * (p.prompt || 0) + (out.metrics.tokens_out || 0) * (p.completion || 0);
      }
      var val = out.metrics[metric];
      return (val === null || val === undefined || val === "") ? null : Number(val);
    }
    function getMetricTone(key, metric) {
      var vals = models.map(function (m) { return { key: modelKey(m), value: metricValue(m, metric) }; }).filter(function (x) { return x.value !== null && !isNaN(x.value); });
      if (vals.length < 2) return null;
      var unique = Array.from(new Set(vals.map(function (x) { return x.value; })));
      if (unique.length < 2) return null;
      vals.sort(function (a, b) { return a.value - b.value; });
      var pos = vals.findIndex(function (x) { return x.key === key; });
      if (pos === -1) return null;
      if (pos === 0) return "good";
      if (pos === vals.length - 1) return "bad";
      return "mid";
    }

    return React.createElement("div", { className: "flex flex-col gap-4 p-4 max-w-[1700px] mx-auto" },
      React.createElement("div", null,
        React.createElement("h1", { className: "text-lg font-expanded text-foreground" }, "Model Playground"),
        React.createElement("p", { className: "text-xs text-muted-foreground mt-1" }, "Compare the same prompt across configured models. Add or remove contenders before each run.")),
      pageError ? React.createElement("div", { className: "text-sm text-red-500 border border-red-500/20 rounded-md px-3 py-2 bg-red-500/10" }, pageError) : null,

      React.createElement(Card, null,
        React.createElement(CardContent, { className: "p-4" },
          React.createElement("div", { className: "flex items-center justify-between gap-2 mb-2" },
            React.createElement(Label, { className: "text-xs uppercase tracking-wide text-muted-foreground" }, "Prompt"),
            React.createElement("div", { className: "flex items-center gap-2" },
              React.createElement("span", { className: "text-[10px] text-muted-foreground" }, prompt.trim().length + " chars"),
              React.createElement(Button, { variant: "default", size: "sm", className: "h-7 px-3 text-[10px]", onClick: function () { setPrompt(randomTestPrompt()); }, title: "Random benchmark prompt" }, "Random Prompt"))),
          React.createElement("textarea", { className: "w-full min-h-[118px] p-3 text-sm leading-relaxed border border-border bg-background/40 rounded-md text-foreground placeholder:text-muted-foreground resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30 focus-visible:border-foreground/25 disabled:opacity-50 normal-case font-courier", placeholder: "Ask something that reveals model differences...", value: prompt, onChange: function (e) { setPrompt(e.target.value); }, disabled: running }),
          React.createElement("details", { className: "mt-3" },
            React.createElement("summary", { className: "cursor-pointer text-xs text-muted-foreground hover:text-foreground mb-2" }, "System prompt (optional)"),
            React.createElement("textarea", { className: "w-full min-h-[76px] p-3 text-sm leading-relaxed border border-border bg-background/40 rounded-md text-foreground placeholder:text-muted-foreground resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30 focus-visible:border-foreground/25 disabled:opacity-50 normal-case font-courier", placeholder: "You are a helpful assistant...", value: system, onChange: function (e) { setSystem(e.target.value); }, disabled: running })),
          React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2 mt-3" },
            React.createElement("div", { className: "flex flex-wrap items-center gap-1.5" },
              models.length ? React.createElement(React.Fragment, null,
                React.createElement("span", { className: "text-[10px] text-muted-foreground mr-1" }, models.length + (models.length === 1 ? " model" : " models")),
                models.map(function (m) { return React.createElement(Badge, { key: modelKey(m), variant: "outline", className: "text-[10px] px-2 py-1 min-h-7 inline-flex items-center", title: m.provider }, m.id); })) : React.createElement("span", { className: "text-xs text-muted-foreground" }, "No models selected"),
              React.createElement(Button, { variant: "default", size: "sm", onClick: function () { setShowAddDialog(true); }, disabled: running, className: "h-7 text-[10px] px-3" }, "Add model")),
            React.createElement("div", { className: "flex items-center gap-2" },
              React.createElement(Button, { variant: "outline", onClick: exportRun, disabled: !anyOutput, size: "sm", className: "h-7 text-[10px] px-2" }, "Export"),
              running ? React.createElement(Button, { variant: "outline", onClick: handleStop, size: "sm", className: "h-7" }, "Stop") : React.createElement(Button, { onClick: handleRun, disabled: !prompt.trim() || models.length === 0, size: "sm", className: "h-7" }, "Run comparison"))))),

      models.length > 0 ? React.createElement("div", { className: "grid gap-3", style: { gridTemplateColumns: models.length <= 1 ? "1fr" : models.length === 2 ? "repeat(2, minmax(280px, 1fr))" : "repeat(auto-fit, minmax(260px, 1fr))" } }, models.map(function (m) { return React.createElement(ModelPane, { key: modelKey(m), model: m, out: outputs[modelKey(m)] || makeOutput(), running: running, pricing: pricing, getMetricTone: getMetricTone, onCopy: function () { copyModelOutput(modelKey(m)); }, onRemove: function () { removeModel(modelKey(m)); } }); })) : React.createElement("div", { className: "border border-dashed border-border rounded-md p-6 text-center text-muted-foreground" },
        React.createElement("div", { className: "font-medium text-foreground mb-1" }, "No models selected"),
        React.createElement("div", { className: "text-sm" }, "Add a model to start comparing responses.")),
      React.createElement(AddModelDialog, { open: showAddDialog, onClose: function () { setShowAddDialog(false); }, onAdd: addCustomModel, onAddCustomProvider: addCustomProvider, providers: allProviders, existing: models.map(function (m) { return modelKey(m); }) }));
  }

  window.__HERMES_PLUGINS__.register("arena", ArenaPage);
})();
