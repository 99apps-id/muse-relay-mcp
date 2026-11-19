'use strict';
/*
 * muse-relay MCP server (zero dependencies, Node >= 18)
 *
 * Exposes your personal Muse (muse.ai) to any MCP host (termigo, ODON,
 * VS Code, Cursor, Gemini CLI, Claude Code, ...) through the muse-relay
 * async file relay:
 *
 *   host --tools/call--> this server --req-<id>.json--> relay inbox
 *   Muse relay worker answers --> res-<id>.json in relay outbox
 *   this server --tool result--> host
 *
 * The relay only works while the muse-relay-inbox hook is enabled on the
 * Muse side and the relay is not paused from the VS Code panel
 * (control.json). Answers typically take 1-10 minutes: the relay worker
 * queue is serial. A watchdog on the Muse side re-wakes unanswered
 * requests after 15 minutes, at most twice.
 *
 * Tools:
 *   ask_muse        blocking: ask and wait for the answer in one call
 *   ask_muse_start  async: submit a question, get a ticket id back at once
 *   ask_muse_check  async: fetch the answer for a ticket id (or "pending")
 *
 * Relay folder: %USERPROFILE%\muse-relay (override with MUSE_RELAY_DIR).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const RELAY_DIR = process.env.MUSE_RELAY_DIR || path.join(os.homedir(), 'muse-relay');
const INBOX = path.join(RELAY_DIR, 'inbox');
const OUTBOX = path.join(RELAY_DIR, 'outbox');
const ARCHIVE = path.join(RELAY_DIR, 'archive');
const CONTROL = path.join(RELAY_DIR, 'control.json');

const SERVER_NAME = 'muse-relay';
const SERVER_VERSION = '1.0.0';
const DEFAULT_PROTOCOL = '2024-11-05';

// ---------------------------------------------------------------- relay io

function readControl() {
  try {
    return JSON.parse(fs.readFileSync(CONTROL, 'utf8'));
  } catch (e) {
    return null;
  }
}

function isPaused() {
  const ctl = readControl();
  return !!(ctl && ctl.paused === true);
}

function genId() {
  return 'mcp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function writeRequest(prompt, opts) {
  opts = opts || {};
  const id = genId();
  const req = {
    id: id,
    createdAt: new Date().toISOString(),
    prompt: prompt,
    answerLanguage: opts.answerLanguage === 'en' ? 'en' : 'id',
    workspaceRoot: opts.workspaceRoot || null,
    activeFile: null,
    contextFile: null,
    selection: null,
    tree: null,
    diff: null,
    source: 'mcp'
  };
  fs.mkdirSync(INBOX, { recursive: true });
  fs.writeFileSync(path.join(INBOX, 'req-' + id + '.json'), JSON.stringify(req, null, 2), 'utf8');
  return id;
}

// Returns { where: 'outbox'|'archive', data } or null.
function findResponse(id) {
  const name = 'res-' + id + '.json';
  const places = [['outbox', OUTBOX], ['archive', ARCHIVE]];
  for (const [where, dir] of places) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      try {
        return { where: where, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
      } catch (e) {
        return { where: where, data: null };
      }
    }
  }
  return null;
}

// After reading an answer from the outbox, move it to the archive (the
// VS Code panel does the same) so the outbox stays clean. Best effort.
function consumeResponse(id, found) {
  if (!found || found.where !== 'outbox') return;
  try {
    fs.mkdirSync(ARCHIVE, { recursive: true });
    fs.renameSync(path.join(OUTBOX, 'res-' + id + '.json'), path.join(ARCHIVE, 'res-' + id + '.json'));
  } catch (e) { /* panel may have archived it first */ }
}

function requestLocation(id) {
  if (fs.existsSync(path.join(INBOX, 'req-' + id + '.json'))) return 'inbox';
  if (fs.existsSync(path.join(ARCHIVE, 'req-' + id + '.json'))) return 'archive';
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pausedError() {
  return {
    isError: true,
    text: 'The Muse relay is PAUSED from the VS Code panel (control.json). Resume the relay in the panel (or ask Muse in the web chat to resume it) before calling ask_muse.'
  };
}

function pendingText(id) {
  const loc = requestLocation(id);
  if (loc === 'inbox') {
    return 'PENDING: request ' + id + ' is still in the relay inbox waiting for a Muse worker. ' +
      'If it stays unanswered for more than ~15 minutes, the relay watchdog re-wakes it automatically (max 2 times). ' +
      'If it has been pending far longer, the relay hook on the Muse side is probably disabled — ask Muse in the web chat to check the relay.';
  }
  if (loc === 'archive') {
    return 'PENDING: request ' + id + ' was archived but no answer file exists yet. Check again shortly.';
  }
  return null;
}

// ------------------------------------------------------------------- tools

const TOOLS = [
  {
    name: 'ask_muse',
    description: 'Ask your personal Muse (muse.ai) a question and WAIT for the answer in this single call (blocking). ' +
      'The answer comes from Claude with long-term memory of your projects, not from a raw model. ' +
      'Typical wait is 1-10 minutes because the relay worker queue is serial; the call gives up after timeoutSecs ' +
      'but the question stays alive — on timeout you get the ticket id and can fetch the answer later with ask_muse_check. ' +
      'Use for a single self-contained question. For long questions, or when your tool-call timeout is short, prefer ask_muse_start + ask_muse_check.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The question or task for Muse. Include any context it needs; Muse cannot see your screen.' },
        workspaceRoot: { type: 'string', description: 'Optional absolute path of the workspace the question is about (helps Muse orient).' },
        answerLanguage: { type: 'string', enum: ['id', 'en'], description: 'Language for Muse\'s answer. Default id (Bahasa Indonesia).' },
        timeoutSecs: { type: 'number', description: 'How long to wait for the answer, seconds. Default 600, min 10, max 1800.' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'ask_muse_start',
    description: 'Submit a question to your personal Muse (muse.ai) WITHOUT waiting (async). Returns a ticket id immediately. ' +
      'Fetch the answer later with ask_muse_check. Use this when the question is long-running or your tool-call timeout is short.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The question or task for Muse. Include any context it needs; Muse cannot see your screen.' },
        workspaceRoot: { type: 'string', description: 'Optional absolute path of the workspace the question is about.' },
        answerLanguage: { type: 'string', enum: ['id', 'en'], description: 'Language for Muse\'s answer. Default id (Bahasa Indonesia).' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'ask_muse_check',
    description: 'Check a ticket from ask_muse_start (or a timed-out ask_muse). Returns Muse\'s answer when ready, or a PENDING status. ' +
      'Safe to call repeatedly.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The ticket id returned by ask_muse_start / ask_muse.' }
      },
      required: ['id']
    }
  }
];

function toolResult(text, isError) {
  return { content: [{ type: 'text', text: text }], isError: !!isError };
}

async function callAskMuse(args) {
  if (isPaused()) { const p = pausedError(); return toolResult(p.text, true); }
  const prompt = String((args && args.prompt) || '').trim();
  if (!prompt) return toolResult('prompt is required.', true);
  let timeoutSecs = Number(args && args.timeoutSecs) || 600;
  timeoutSecs = Math.min(1800, Math.max(10, timeoutSecs));
  const id = writeRequest(prompt, args);
  const deadline = Date.now() + timeoutSecs * 1000;
  while (Date.now() < deadline) {
    const found = findResponse(id);
    if (found) {
      consumeResponse(id, found);
      if (found.data && typeof found.data.answer === 'string') return toolResult(found.data.answer, false);
      return toolResult('Muse returned an unreadable answer file for request ' + id + '.', true);
    }
    await sleep(2000);
  }
  return toolResult(
    'TIMEOUT after ' + timeoutSecs + 's: Muse has not answered yet, but the question is still queued (ticket ' + id + '). ' +
    'Fetch the answer later with ask_muse_check using this ticket id. Do not resubmit the same question.',
    true
  );
}

function callAskMuseStart(args) {
  if (isPaused()) { const p = pausedError(); return toolResult(p.text, true); }
  const prompt = String((args && args.prompt) || '').trim();
  if (!prompt) return toolResult('prompt is required.', true);
  const id = writeRequest(prompt, args);
  return toolResult(JSON.stringify({
    id: id,
    status: 'queued',
    note: 'Question submitted to the Muse relay. Fetch the answer with ask_muse_check. Typical wait 1-10 minutes.'
  }), false);
}

function callAskMuseCheck(args) {
  const id = String((args && args.id) || '').trim();
  if (!id) return toolResult('id is required.', true);
  const found = findResponse(id);
  if (found) {
    consumeResponse(id, found);
    if (found.data && typeof found.data.answer === 'string') return toolResult(found.data.answer, false);
    return toolResult('Muse returned an unreadable answer file for request ' + id + '.', true);
  }
  const pending = pendingText(id);
  if (pending) return toolResult(pending, false);
  return toolResult('Unknown ticket id ' + id + ': no request or answer file exists for it in the relay folders.', true);
}

// -------------------------------------------------------------- json-rpc

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id: id, result: result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } });
}

async function handle(msg) {
  const method = msg.method;
  const id = msg.id;
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    const clientProtocol = msg.params && msg.params.protocolVersion;
    reply(id, {
      protocolVersion: clientProtocol || DEFAULT_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
    });
    return;
  }
  if (isNotification) return; // notifications/initialized, cancelled, ...
  if (method === 'ping') { reply(id, {}); return; }
  if (method === 'tools/list') { reply(id, { tools: TOOLS }); return; }
  if (method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    try {
      if (name === 'ask_muse') { reply(id, await callAskMuse(args)); return; }
      if (name === 'ask_muse_start') { reply(id, callAskMuseStart(args)); return; }
      if (name === 'ask_muse_check') { reply(id, callAskMuseCheck(args)); return; }
      replyError(id, -32602, 'Unknown tool: ' + name);
      return;
    } catch (e) {
      reply(id, toolResult('muse-relay server error: ' + (e && e.message ? e.message : String(e)), true));
      return;
    }
  }
  replyError(id, -32601, 'Method not found: ' + method);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (e) {
    return; // not JSON: ignore (stdio transport is newline-delimited JSON)
  }
  if (Array.isArray(msg)) {
    msg.forEach((m) => { handle(m).catch(() => {}); });
  } else {
    handle(msg).catch(() => {});
  }
});
