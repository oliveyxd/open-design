// @ts-nocheck
import express from 'express';
import { spawn, execFile } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

/**
 * Aggressively simplified daemon HTTP server.
 * - Only supports two local CLI agents: claude and copilot
 * - Exposes: GET /api/agents and POST /api/chat
 * - Provides a tiny test page at GET /test
 *
 * This file intentionally strips the original server's surface and
 * dependencies so it is easy to reason about and test in a minimal env.
 */

const PORT = Number(process.env.OD_PORT || process.env.PORT || 7456);
const HOST = process.env.OD_BIND_HOST || '127.0.0.1';
const app = express();
app.use(express.json({ limit: '1mb' }));

const AGENTS = [
  { id: 'claude', name: 'Claude Code', envVar: 'CLAUDE_BIN', fallbackModels: ['claude-2.1', 'claude-1.3'] },
  { id: 'copilot', name: 'GitHub Copilot CLI', envVar: 'COPILOT_BIN', fallbackModels: ['copilot-v1'] },
];

function randomId() {
  return Math.random().toString(36).slice(2, 9);
}

async function probeAgent(agent) {
  // 1. env override
  const envPath = process.env[agent.envVar];
  if (envPath && typeof envPath === 'string') {
    // quick sanity: exists?
    try {
      if (fs.existsSync(envPath)) {
        const version = await probeVersion(envPath).catch(() => null);
        return { id: agent.id, name: agent.name, available: true, path: envPath, version, models: agent.fallbackModels };
      }
    } catch {
      // fallthrough
    }
  }

  // 2. try --version on PATH binary name
  try {
    const version = await probeVersion(agent.id);
    return { id: agent.id, name: agent.name, available: true, path: agent.id, version, models: agent.fallbackModels };
  } catch {
    return { id: agent.id, name: agent.name, available: false, path: null, version: null, models: agent.fallbackModels };
  }
}

function probeVersion(bin) {
  return new Promise((resolve, reject) => {
    execFile(bin, ['--version'], { timeout: 3000 }, (err, stdout) => {
      if (err) return reject(err);
      const text = String(stdout || '').trim();
      if (text.length === 0) return resolve(null);
      resolve(text.split('\n')[0]);
    });
  });
}

app.get('/api/agents', async (_req, res) => {
  try {
    const results = await Promise.all(AGENTS.map((a) => probeAgent(a)));
    res.json({ agents: results });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

function createSse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  let closed = false;
  res.on('close', () => { closed = true; });
  return {
    send(event, data) {
      if (closed) return false;
      const id = Date.now();
      res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    },
    end() {
      if (closed) return;
      res.end();
    }
  };
}

app.post('/api/chat', async (req, res) => {
  const body = req.body || {};
  const agentId = typeof body.agentId === 'string' ? body.agentId : 'claude';
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const def = AGENTS.find((a) => a.id === agentId);
  if (!def) return res.status(400).json({ error: 'unknown agentId' });

  const probe = await probeAgent(def);
  if (!probe.available) return res.status(404).json({ error: `${def.name} not available` });

  const sse = createSse(res);
  sse.send('start', { agentId: def.id, model: req.body.model ?? null });

  // Spawn the CLI, write prompt to stdin and stream stdout as 'delta' events.
  // We keep args minimal: many CLIs accept reading from stdin; if not, the
  // executed binary may error and we'll forward stderr.
  let child;
  try {
    const bin = probe.path || def.id;
    const args = [];
    child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    sse.send('error', { message: 'spawn failed', detail: String(err) });
    sse.end();
    return;
  }

  child.stdin.setDefaultEncoding('utf8');
  child.stdin.write(prompt);
  child.stdin.end();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    sse.send('delta', { delta: String(chunk) });
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    sse.send('stderr', { chunk: String(chunk) });
  });

  child.on('close', (code) => {
    sse.send('end', { code });
    sse.end();
  });

  child.on('error', (err) => {
    sse.send('error', { message: String(err) });
    sse.end();
  });
});

// Minimal test page for simple dialogs.
app.get('/test', (_req, res) => {
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Agent test</title>
</head>
<body>
  <h1>Simple Agent Test (Claude / Copilot)</h1>
  <label>Agent:
    <select id="agent">
      <option value="claude">Claude Code</option>
      <option value="copilot">Copilot CLI</option>
    </select>
  </label>
  <div>
    <textarea id="prompt" rows="8" cols="80">Write a short greeting.</textarea>
  </div>
  <button id="start">Start</button>
  <pre id="out" style="white-space:pre-wrap;border:1px solid #ccc;padding:8px;height:240px;overflow:auto"></pre>
  <script>
    document.getElementById('start').addEventListener('click', async () => {
      const agent = document.getElementById('agent').value;
      const prompt = document.getElementById('prompt').value;
      const out = document.getElementById('out');
      out.textContent = '';
      const resp = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: agent, prompt })
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => null);
        out.textContent = 'Error: ' + (j?.error || resp.statusText || resp.status);
        return;
      }
      // Read SSE stream from the POST response body (server keeps it open)
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // crude SSE frame splitter
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 2);
          const lines = frame.split(/\r?\n/);
          let data = lines.find(l => l.startsWith('data:'));
          if (data) data = data.slice(5).trim();
          try {
            const parsed = JSON.parse(data);
            if (parsed.delta) out.textContent += parsed.delta;
            else if (parsed.chunk) out.textContent += parsed.chunk;
            else if (parsed.message) out.textContent += '\n[message] ' + parsed.message + '\n';
          } catch (e) {
            out.textContent += '\n[raw] ' + data + '\n';
          }
        }
      }
      out.textContent += '\n[done]';
    });
  </script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

export async function startServer({ port = PORT, host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      const reportHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
      const url = `http://${reportHost}:${boundPort}`;
      console.log(`[od-simple] listening on ${url}`);
      resolve({ url, server });
    });
    server.on('error', (err) => reject(err));
  });
}

if (require.main === module) {
  startServer().catch((e) => {
    console.error('Failed to start simple daemon:', e);
    process.exit(1);
  });
}
