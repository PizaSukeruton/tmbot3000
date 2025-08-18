// backend/server.js
// Minimal HTTP + WebSocket server for TmBot3000 (Render-ready; no Express).
// - Serves a simple test UI from /public
// - REST: /health, /api/chat/message (POST), /api/chat/history (GET)
// - WS:   /ws  (real-time chat)
// - Graceful shutdown, CORS, and robust error handling

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const url = require('url');
const WebSocket = require('ws');

// --- App services & deps -----------------------------------------------------
const pool = require('./db/pool');
const intentMatcher = require('./services/tmIntentMatcher'); // singleton
const { generateHexId } = require('./utils/generateHexId');
const TmAiEngine = require('./services/tmAiEngine');
const { createCsvDataSource } = require('./services/csvDataSource');

// Initialize AI Engine
const dataSource = createCsvDataSource({ dataDir: process.env.TM_DATA_DIR || './data' });
const aiEnginePromise = TmAiEngine.create({ dataSource });
let aiEngine;
aiEnginePromise.then(engine => { aiEngine = engine; console.log('[AI] Engine initialized'); });
const TmMessageProcessor = require('./services/tmMessageProcessor');

setTimeout(() => {
  if (!aiEngine) { console.error('[ERROR] AI Engine not ready'); process.exit(1); }
  const processor = new TmMessageProcessor({
  pool,
  intentMatcher,
  aiEngine,
  generateHexId,
  });
  global.processor = processor;
}, 1000);

const getProcessor = () => global.processor;

// --- Config ------------------------------------------------------------------
const PORT = parseInt(process.env.PORT, 10) || 3000;
const isProd = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(__dirname, 'public');

const HEARTBEAT_INTERVAL_MS = 30_000;

// --- Utility helpers ---------------------------------------------------------
function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(text);
}

function notFound(res) {
  sendText(res, 404, 'Not Found');
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        // ~1MB safeguard
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        const data = raw ? JSON.parse(raw) : {};
        resolve(data);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  // Only serve files under /public; default to index.html
  const parsed = url.parse(req.url);
  let pathname = parsed.pathname;
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return notFound(res);
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return notFound(res);

    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === '.html' ? 'text/html; charset=utf-8' :
      ext === '.js'   ? 'application/javascript; charset=utf-8' :
      ext === '.css'  ? 'text/css; charset=utf-8' :
      ext === '.json' ? 'application/json; charset=utf-8' :
      'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': mime,
      'Access-Control-Allow-Origin': '*',
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', () => notFound(res));
  });
}

// --- HTTP routing ------------------------------------------------------------
async function handleHttpRequest(req, res) {
  const { method } = req;
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  try {
    // Health
    if (method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true, status: 'healthy', uptime: process.uptime() });
    }

    // Basic API: chat message via HTTP POST (fallback when WS isn’t used)
    if (method === 'POST' && pathname === '/api/chat/message') {
      const body = await readJsonBody(req);
      const { sessionId, memberId, content } = body || {};
      const result = await getProcessor().processMessage({ sessionId, memberId, content });

      if (!result.success) {
        return sendJson(res, 400, { ok: false, error: result.error || 'processing_failed' });
      }

      return sendJson(res, 200, {
        ok: true,
        sessionId: result.data.sessionId,
        messageId: result.data.botMessageId,
        response: result.data.response,
        intent: result.data.intent,
        entities: result.data.entities,
      });
    }

    // Chat history
    if (method === 'GET' && pathname === '/api/chat/history') {
      const sessionId = parsed.query.sessionId;
      const limit = Math.min(parseInt(parsed.query.limit, 10) || 50, 200);
      if (!sessionId) return sendJson(res, 400, { ok: false, error: 'sessionId required' });

      const rows = await getProcessor().getSessionContext(sessionId, limit);
      return sendJson(res, 200, { ok: true, messages: rows });
    }

    // Static UI and assets
    if (method === 'GET' && (pathname === '/' || pathname.startsWith('/public/'))) {
      return serveStatic(req, res);
    }

    // Favicon: return 204 (optional)
    if (method === 'GET' && pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    // Default: 404
    return notFound(res);
  } catch (err) {
    console.error('[HTTP] error:', err);
    return sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
}

// --- WebSocket handling ------------------------------------------------------
function setupWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });
  console.log('[WS] listening on /ws');

  // Heartbeat
  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data) => {
      let payload;
      try {
        payload = JSON.parse(String(data || '{}'));
      } catch {
        return ws.send(JSON.stringify({ type: 'error', error: 'invalid_json' }));
      }

      if (payload.type !== 'message') {
        return ws.send(JSON.stringify({ type: 'error', error: 'unsupported_type' }));
      }

      const { sessionId, memberId, content } = payload;
      if (!memberId || !content) {
        return ws.send(JSON.stringify({ type: 'error', error: 'memberId and content required' }));
      }

      try {
        const result = await getProcessor().processMessage({ sessionId, memberId, content });
        if (!result.success) {
          return ws.send(JSON.stringify({ type: 'error', error: result.error || 'processing_failed' }));
        }

        ws.send(JSON.stringify({
          type: 'response',
          sessionId: result.data.sessionId,
          messageId: result.data.botMessageId,
          content: result.data.response,
          intent: result.data.intent,
          entities: result.data.entities,
        }));
      } catch (e) {
        console.error('[WS] process error:', e);
        ws.send(JSON.stringify({ type: 'error', error: 'internal_error' }));
      }
    });

    ws.on('error', (e) => console.warn('[WS] socket error:', e.message));
  });

  // Ping/pong keepalive
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    });
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => clearInterval(interval));
  return wss;
}

// --- Bootstrap ---------------------------------------------------------------
function start() {
  const server = http.createServer(handleHttpRequest);
  const wss = setupWebSocket(server);

  server.listen(PORT, () => {
    console.log(`[HTTP] Server running on http://localhost:${PORT} (env=${process.env.NODE_ENV || 'dev'})`);
  });

  // Graceful shutdown for Render/containers
  const shutdown = async (signal) => {
    console.log(`[SHUTDOWN] Received ${signal}. Closing server...`);
    server.close(() => console.log('[HTTP] server closed'));
    // Close WS clients
    wss.clients.forEach((ws) => {
      try { ws.close(1001, 'Server shutting down'); } catch {}
    });
    // Allow a brief window for sockets to close
    setTimeout(async () => {
      try { await pool.end(); console.log('[DB] pool closed'); } catch {}
      process.exit(0);
    }, 1000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();

