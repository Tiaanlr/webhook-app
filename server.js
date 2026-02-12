const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.VERCEL ? "/tmp" : path.join(__dirname, "data");
const CONFIGS_FILE = path.join(DATA_DIR, "configs.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Ensure data directory and configs file exist ──
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(CONFIGS_FILE)) {
  fs.writeFileSync(CONFIGS_FILE, JSON.stringify({}, null, 2));
}

function readConfigs() {
  return JSON.parse(fs.readFileSync(CONFIGS_FILE, "utf-8"));
}

function writeConfigs(configs) {
  fs.writeFileSync(CONFIGS_FILE, JSON.stringify(configs, null, 2));
}

// In-memory store for received webhooks
const webhooks = [];

// SSE clients
const sseClients = [];

// ── Config CRUD endpoints ──

// GET /api/configs — list all saved config names
app.get("/api/configs", (req, res) => {
  const configs = readConfigs();
  res.json({ ok: true, names: Object.keys(configs) });
});

// GET /api/configs/:name — load a specific config
app.get("/api/configs/:name", (req, res) => {
  const configs = readConfigs();
  const name = req.params.name;
  if (!configs[name]) {
    return res.status(404).json({ ok: false, error: "Config not found" });
  }
  res.json({ ok: true, name, rules: configs[name] });
});

// POST /api/configs — save a config { name, rules: [...] }
app.post("/api/configs", (req, res) => {
  const { name, rules } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ ok: false, error: "Name is required" });
  }
  if (!rules || !Array.isArray(rules)) {
    return res
      .status(400)
      .json({ ok: false, error: "Rules array is required" });
  }
  const configs = readConfigs();
  configs[name.trim()] = rules;
  writeConfigs(configs);
  res.json({ ok: true, name: name.trim() });
});

// DELETE /api/configs/:name — delete a saved config
app.delete("/api/configs/:name", (req, res) => {
  const configs = readConfigs();
  const name = req.params.name;
  if (!configs[name]) {
    return res.status(404).json({ ok: false, error: "Config not found" });
  }
  delete configs[name];
  writeConfigs(configs);
  res.json({ ok: true });
});

// ── Webhook endpoints ──

// POST /api/webhook/receive — accept incoming webhook payloads
app.post("/api/webhook/receive", (req, res) => {
  const event = {
    id: webhooks.length + 1,
    receivedAt: new Date().toISOString(),
    headers: {
      "content-type": req.headers["content-type"],
      "user-agent": req.headers["user-agent"],
    },
    body: req.body,
  };

  webhooks.push(event);
  console.log(`Webhook received (#${event.id}):`, JSON.stringify(event.body));

  // Push to all SSE clients
  for (const client of sseClients) {
    client.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  res.json({ ok: true, id: event.id });
});

// POST /api/webhook/send — send a webhook to an external URL
app.post("/api/webhook/send", async (req, res) => {
  const { url, payload } = req.body;

  if (!url) {
    return res.status(400).json({ ok: false, error: "Missing target URL" });
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });

    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }

    res.json({
      ok: true,
      status: response.status,
      statusText: response.statusText,
      body,
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// GET /api/events — SSE stream for real-time webhook events
app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  // Send existing events as initial batch
  for (const event of webhooks) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  sseClients.push(res);

  req.on("close", () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Webhook app running at http://0.0.0.0:${PORT}`);
  console.log(
    `Receive webhooks at POST http://localhost:${PORT}/api/webhook/receive`,
  );
});
