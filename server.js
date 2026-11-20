#!/usr/bin/env node
'use strict';
/*
 * muse-relay MCP server (zero dependencies, Node >= 18)
 *
 * Exposes your personal Muse (muse.ai) to any MCP host (VS Code, Claude Code,
 * Claude Desktop, OpenAI Codex CLI, Google Antigravity, Cursor, Windsurf,
 * Gemini CLI, termigo, ODON, ...) through the muse-relay async file relay:
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
 *   ask_muse_check  async / long-poll: fetch the answer for a ticket id
 *                   (returns immediately when ready, or waits up to waitSecs)
 *
 * Relay folder: %USERPROFILE%\muse-relay (override with MUSE_RELAY_DIR).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const RELAY_DIR = process.env.MUSE_RELAY_DIR && process.env.MUSE_RELAY_DIR.trim()
  ? path.resolve(process.env.MUSE_RELAY_DIR.trim())
  : path.join(os.homedir(), 'muse-relay');
const INBOX = path.join(RELAY_DIR, 'inbox');
const OUTBOX = path.join(RELAY_DIR, 'outbox');
const ARCHIVE = path.join(RELAY_DIR, 'archive');
const PENDING_DIR = path.join(RELAY_DIR, 'pending');
const CONTROL = path.join(RELAY_DIR, 'control.json');

const SERVER_NAME = 'muse-relay';
const SERVER_VERSION = '0.1.2';

// Approval mode (control.json requireApproval === true, set from the Muse
// Companion panel): new requests are written to PENDING_DIR instead of the
// inbox and only reach Muse after the owner approves them in the panel.
// Unapproved requests expire after this TTL and receive an expiry answer.
const APPROVAL_TTL_MS = (() => {
  const v = Number(process.env.MUSE_RELAY_APPROVAL_TTL_MS);
  return Number.isFinite(v) && v >= 1000 ? v : 30 * 60 * 1000;
})();
const DEFAULT_PROTOCOL = '2024-11-05';
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// Grace period (ms) for an answer file that is currently being streamed over SSH
const PARTIAL_WRITE_GRACE_MS = 10000;

// Active in-flight JSON-RPC requests (requestIdKey -> { cancelled: boolean, onCancel: Function[] })
const activeRequests = new Map();

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

function approvalRequired() {
  const ctl = readControl();
  return !!(ctl && ctl.requireApproval === true);
}

function genId() {
  return 'mcp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function isValidTicketId(id) {
  return typeof id === 'string' && SAFE_ID_RE.test(id);
}

// Returns { id, pendingApproval }. With approval mode on, the request lands
// in PENDING_DIR (invisible to the Muse-side polling hook) until the owner
// approves it in the Muse Companion panel, which moves it into the inbox.
function writeRequest(prompt, opts) {
  opts = opts || {};
  const id = genId();
  const needsApproval = approvalRequired();
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
  if (needsApproval) {
    req.needsApproval = true;
    req.approvalStatus = 'pending';
  }
  const targetDir = needsApproval ? PENDING_DIR : INBOX;
  fs.mkdirSync(targetDir, { recursive: true });
  const payload = JSON.stringify(req, null, 2);
  const finalPath = path.join(targetDir, 'req-' + id + '.json');
  const tmpPath = path.join(targetDir, '.tmp-req-' + id + '.json');
  try {
    // Atomic write: write to hidden dotfile first so the SSH polling hook
    // (which globs req-*.json) never sees a half-written request file.
    fs.writeFileSync(tmpPath, payload, 'utf8');
    fs.renameSync(tmpPath, finalPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    fs.writeFileSync(finalPath, payload, 'utf8');
  }
  return { id: id, pendingApproval: needsApproval };
}

// Returns { where: 'outbox'|'archive', data, partial?: boolean, mtimeMs?: number } or null.
function findResponse(id) {
  if (!isValidTicketId(id)) return null;
  const name = 'res-' + id + '.json';
  const places = [['outbox', OUTBOX], ['archive', ARCHIVE]];
  for (const [where, dir] of places) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.answer === 'string') {
          return { where: where, data: parsed, partial: false };
        }
        const stat = fs.statSync(p);
        return { where: where, data: parsed, partial: true, mtimeMs: stat.mtimeMs };
      } catch (e) {
        let mtimeMs = Date.now();
        try { mtimeMs = fs.statSync(p).mtimeMs; } catch (_) { /* ignore */ }
        return { where: where, data: null, partial: true, mtimeMs: mtimeMs };
      }
    }
  }
  return null;
}

// After reading a complete answer from the outbox, move it to the archive
// (the VS Code panel does the same) so the outbox stays clean. Best effort.
function consumeResponse(id, found) {
  if (!found || found.where !== 'outbox' || found.partial) return;
  if (!isValidTicketId(id)) return;
  try {
    fs.mkdirSync(ARCHIVE, { recursive: true });
    fs.renameSync(path.join(OUTBOX, 'res-' + id + '.json'), path.join(ARCHIVE, 'res-' + id + '.json'));
  } catch (e) { /* panel may have archived it first */ }
}

function requestLocation(id) {
  if (!isValidTicketId(id)) return null;
  if (fs.existsSync(path.join(PENDING_DIR, 'req-' + id + '.json'))) return 'pending';
  if (fs.existsSync(path.join(INBOX, 'req-' + id + '.json'))) return 'inbox';
  if (fs.existsSync(path.join(ARCHIVE, 'req-' + id + '.json'))) return 'archive';
  return null;
}

// If a request has waited in PENDING_DIR longer than APPROVAL_TTL_MS, expire
// it: write an expiry answer to the outbox and archive the request file, so
// ask_muse_check returns a definitive result instead of waiting forever.
// Returns true when the request was expired by this call.
function expireStalePending(id) {
  if (!isValidTicketId(id)) return false;
  const reqPath = path.join(PENDING_DIR, 'req-' + id + '.json');
  let createdMs = NaN;
  try {
    const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
    createdMs = Date.parse(req && req.createdAt);
    if (Number.isNaN(createdMs)) createdMs = fs.statSync(reqPath).mtimeMs;
  } catch (e) {
    return false; // not in pending (or unreadable): nothing to expire
  }
  if (Date.now() - createdMs < APPROVAL_TTL_MS) return false;
  const mins = Math.round(APPROVAL_TTL_MS / 60000);
  const res = {
    id: id,
    answeredAt: new Date().toISOString(),
    answer: 'EXPIRED: the owner did not approve this request within ' + mins + ' minutes, so it was never sent to Muse. ' +
      'Ask the user whether they want to submit it again.',
    source: 'muse-relay-server'
  };
  try {
    fs.mkdirSync(OUTBOX, { recursive: true });
    fs.mkdirSync(ARCHIVE, { recursive: true });
    const tmpPath = path.join(OUTBOX, '.tmp-res-' + id + '.json');
    fs.writeFileSync(tmpPath, JSON.stringify(res, null, 2), 'utf8');
    fs.renameSync(tmpPath, path.join(OUTBOX, 'res-' + id + '.json'));
    fs.renameSync(reqPath, path.join(ARCHIVE, 'req-' + id + '.json'));
    return true;
  } catch (e) {
    return false;
  }
}

function approvalPendingText(id, waitedSecs) {
  const waitedNote = waitedSecs ? ' (waited ' + waitedSecs + 's in this check)' : '';
  const mins = Math.round(APPROVAL_TTL_MS / 60000);
  return 'APPROVAL_PENDING' + waitedNote + ': request ' + id + ' is waiting for the owner to approve it in the Muse Companion panel (VS Code). ' +
    'It has NOT reached Muse yet. Once approved it flows through the normal relay; if it is not approved within ' + mins + ' minutes it expires. ' +
    'Call ask_muse_check again with id="' + id + '" to keep waiting, and tell the user it is waiting for their approval in the panel.';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Instant event-driven wait with fallback timer:
// Watches OUTBOX and ARCHIVE via fs.watch so as soon as res-<id>.json is
// written, we wake up within milliseconds instead of waiting for a fixed poll interval.
function waitForResponseOrTimeout(id, maxWaitMs, reqState, onTick) {
  return new Promise((resolve) => {
    const targetFile = 'res-' + id + '.json';
    const deadline = Date.now() + maxWaitMs;
    let settled = false;
    const watchers = [];
    const pendingTimers = new Set();
    let pollTimer = null;
    let tickCounter = 0;

    function scheduleCheck(delayMs) {
      if (settled) return;
      const t = setTimeout(() => {
        pendingTimers.delete(t);
        checkNow();
      }, delayMs);
      pendingTimers.add(t);
    }

    function cleanup() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      for (const t of pendingTimers) {
        clearTimeout(t);
      }
      pendingTimers.clear();
      while (watchers.length > 0) {
        const w = watchers.pop();
        try { w.close(); } catch (_) { /* ignore */ }
      }
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    function checkNow() {
      if (settled) return;
      if (reqState && reqState.cancelled) {
        finish({ cancelled: true, found: null });
        return;
      }
      // Expire a pending approval lazily as soon as its TTL elapses during the wait
      expireStalePending(id);
      const found = findResponse(id);
      if (found) {
        if (!found.partial && found.data && typeof found.data.answer === 'string') {
          finish({ cancelled: false, found: found });
          return;
        }
        // If partial write exceeded grace period, stop waiting and report it
        const ageMs = Date.now() - (found.mtimeMs || 0);
        if (ageMs > PARTIAL_WRITE_GRACE_MS) {
          finish({ cancelled: false, found: found });
          return;
        }
        // Otherwise file is actively arriving over SSH; re-check very soon (150ms)
        scheduleCheck(150);
        return;
      }
      if (Date.now() >= deadline) {
        finish({ cancelled: false, found: null });
      }
    }

    // Immediate check first (0ms latency if already answered)
    checkNow();
    if (settled) return;

    if (reqState && Array.isArray(reqState.onCancel)) {
      reqState.onCancel.push(() => finish({ cancelled: true, found: null }));
    }

    // Attach fs.watch on OUTBOX and ARCHIVE for instant wakeup when Muse finishes
    for (const dir of [OUTBOX, ARCHIVE]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const watcher = fs.watch(dir, (eventType, filename) => {
          if (!filename || filename === targetFile) {
            // Brief 40ms debounce so the file write flush finishes before read
            scheduleCheck(40);
          }
        });
        watcher.on('error', () => { /* fallback polling handles errors */ });
        watchers.push(watcher);
      } catch (_) {
        // Directory watch unavailable; fallback interval below still covers it
      }
    }

    // Fallback 1-second poll + progress heartbeat
    pollTimer = setInterval(() => {
      tickCounter++;
      if (onTick && tickCounter % 10 === 0) {
        try { onTick(tickCounter); } catch (_) { /* ignore */ }
      }
      checkNow();
    }, 1000);
  });
}

function pausedError() {
  return {
    isError: true,
    text: 'The Muse relay is PAUSED from the VS Code panel (control.json). Resume the relay in the panel (or ask Muse in the web chat to resume it) before calling ask_muse.'
  };
}

function pendingText(id, waitedSecs) {
  const loc = requestLocation(id);
  const waitedNote = waitedSecs ? ' (waited ' + waitedSecs + 's in this check)' : '';
  if (loc === 'pending') {
    return approvalPendingText(id, waitedSecs);
  }
  if (loc === 'inbox') {
    return 'PENDING' + waitedNote + ': request ' + id + ' is still in the relay inbox waiting for a Muse worker. ' +
      'Call ask_muse_check again with id="' + id + '" (you can set waitSecs up to 120) to keep waiting. ' +
      'If it stays unanswered for more than ~15 minutes, the relay watchdog re-wakes it automatically (max 2 times). ' +
      'If it has been pending far longer than that, the relay hook on the Muse side is probably disabled - ask Muse in the web chat to check the relay.';
  }
  if (loc === 'archive') {
    return 'PENDING' + waitedNote + ': request ' + id + ' was picked up and archived by the Muse worker, and is currently being processed. ' +
      'Call ask_muse_check again with id="' + id + '" to wait for the answer file.';
  }
  return null;
}

// ------------------------------------------------------------------- tools

const TOOLS = [
  {
    name: 'ask_muse',
    description: 'Ask your personal Muse (muse.ai) a question and WAIT for the answer in this single call (blocking). ' +
      'As soon as Muse finishes, the answer is delivered immediately via filesystem event watch. ' +
      'Typical wait is 1-10 minutes because the relay worker queue is serial; the call waits up to timeoutSecs ' +
      '(default 600s, up to 3600s). If timeoutSecs is reached before Muse finishes, the question stays alive and ' +
      'returns the ticket id so you can continue waiting with ask_muse_check. ' +
      'If your MCP host has a short tool-call timeout (e.g. 60-120s), either pass a smaller timeoutSecs or use ask_muse_start + ask_muse_check.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The question or task for Muse. Include any context it needs; Muse cannot see your screen.' },
        workspaceRoot: { type: 'string', description: 'Optional absolute path of the workspace the question is about (helps Muse orient).' },
        answerLanguage: { type: 'string', enum: ['id', 'en'], description: 'Language for Muse\'s answer. Default id (Bahasa Indonesia).' },
        timeoutSecs: { type: 'number', description: 'How long to wait for the answer in seconds. Default 600, min 5, max 3600.' }
      },
      required: ['prompt'],
      additionalProperties: false
    },
    annotations: {
      title: 'Ask Muse (Blocking)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: 'ask_muse_start',
    description: 'Submit a question to your personal Muse (muse.ai) WITHOUT waiting (async). Returns a ticket id immediately. ' +
      'Fetch the answer with ask_muse_check (which supports waiting per check via waitSecs). ' +
      'Preferred for coding agents so tool calls never hit host timeouts. ' +
      'If the owner enabled approval mode in the Muse Companion panel, the question first waits for their approval (status awaiting_approval) before it reaches Muse.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The question or task for Muse. Include any context it needs; Muse cannot see your screen.' },
        workspaceRoot: { type: 'string', description: 'Optional absolute path of the workspace the question is about.' },
        answerLanguage: { type: 'string', enum: ['id', 'en'], description: 'Language for Muse\'s answer. Default id (Bahasa Indonesia).' }
      },
      required: ['prompt'],
      additionalProperties: false
    },
    annotations: {
      title: 'Ask Muse Start (Async Submit)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: 'ask_muse_check',
    description: 'Check or wait for a ticket from ask_muse_start (or a timed-out ask_muse). ' +
      'If the answer is already in the outbox, returns IMMEDIATELY (0ms). ' +
      'If not ready yet, waits up to waitSecs (default 25s, range 0-600s) watching the outbox in real time and returns the instant Muse finishes. ' +
      'If still pending after waitSecs, returns a PENDING status — simply call ask_muse_check again to continue waiting. ' +
      'A ticket that is waiting for the owner\'s approval in the Muse Companion panel reports APPROVAL_PENDING instead.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The ticket id returned by ask_muse_start / ask_muse.' },
        waitSecs: { type: 'number', description: 'Seconds to wait for the answer before returning PENDING (default 25, min 0 for instant check, max 600). Returns immediately as soon as the answer arrives.' }
      },
      required: ['id'],
      additionalProperties: false
    },
    annotations: {
      title: 'Ask Muse Check (Fetch / Long-Poll Ticket)',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }
];

function toolResult(text, isError) {
  return { content: [{ type: 'text', text: text }], isError: !!isError };
}

async function callAskMuse(args, reqState) {
  if (isPaused()) { const p = pausedError(); return toolResult(p.text, true); }
  const prompt = String((args && args.prompt) || '').trim();
  if (!prompt) return toolResult('prompt is required.', true);
  let timeoutSecs = (args && args.timeoutSecs !== undefined && args.timeoutSecs !== null)
    ? Number(args.timeoutSecs)
    : 600;
  if (Number.isNaN(timeoutSecs)) timeoutSecs = 600;
  timeoutSecs = Math.min(3600, Math.max(5, timeoutSecs));

  const id = writeRequest(prompt, args).id;
  const outcome = await waitForResponseOrTimeout(
    id,
    timeoutSecs * 1000,
    reqState,
    (elapsedSecs) => {
      if (reqState && reqState.progressToken !== undefined && reqState.progressToken !== null) {
        sendProgress(reqState.progressToken, elapsedSecs, timeoutSecs, 'Waiting for Muse answer (ticket ' + id + ', ' + elapsedSecs + 's elapsed)...');
      }
    }
  );

  if (outcome.cancelled) return null;
  if (outcome.found) {
    if (!outcome.found.partial && outcome.found.data && typeof outcome.found.data.answer === 'string') {
      consumeResponse(id, outcome.found);
      return toolResult(outcome.found.data.answer, false);
    }
    return toolResult('Muse returned an unreadable answer file for request ' + id + '.', true);
  }

  // The approval TTL may have elapsed during the wait: expire lazily so the
  // caller gets the definitive expiry answer instead of a soft PENDING.
  if (expireStalePending(id)) {
    const expired = findResponse(id);
    if (expired && !expired.partial && expired.data && typeof expired.data.answer === 'string') {
      consumeResponse(id, expired);
      return toolResult(expired.data.answer, false);
    }
  }
  if (requestLocation(id) === 'pending') {
    return toolResult(approvalPendingText(id, timeoutSecs), false);
  }

  // Return isError: false so strict coding agents don't abort the turn on timeout,
  // and instead smoothly transition to calling ask_muse_check with the ticket id.
  return toolResult(
    'PENDING (waited ' + timeoutSecs + 's): Muse is still working on your question (ticket ' + id + '). ' +
    'The question was NOT cancelled. Call ask_muse_check with {"id": "' + id + '", "waitSecs": 45} to continue waiting for the answer. ' +
    'Do not resubmit the same question.',
    false
  );
}

function callAskMuseStart(args) {
  if (isPaused()) { const p = pausedError(); return toolResult(p.text, true); }
  const prompt = String((args && args.prompt) || '').trim();
  if (!prompt) return toolResult('prompt is required.', true);
  const submitted = writeRequest(prompt, args);
  const id = submitted.id;
  if (submitted.pendingApproval) {
    const mins = Math.round(APPROVAL_TTL_MS / 60000);
    return toolResult(JSON.stringify({
      id: id,
      status: 'awaiting_approval',
      note: 'Approval mode is on: this question is waiting for the owner to approve it in the Muse Companion panel (VS Code) before it reaches Muse. It expires after ' + mins + ' minutes without approval. Call ask_muse_check with {"id": "' + id + '"} to wait for the outcome, and tell the user it is waiting for their approval in the panel.'
    }), false);
  }
  return toolResult(JSON.stringify({
    id: id,
    status: 'queued',
    note: 'Question submitted to the Muse relay. Call ask_muse_check with {"id": "' + id + '"} to wait for and fetch the answer. As soon as Muse finishes, ask_muse_check returns immediately.'
  }), false);
}

async function callAskMuseCheck(args, reqState) {
  const id = String((args && args.id) || '').trim();
  if (!id) return toolResult('id is required.', true);
  if (!isValidTicketId(id)) {
    return toolResult('Invalid ticket id format: ' + id + '.', true);
  }

  let waitSecs = (args && args.waitSecs !== undefined && args.waitSecs !== null)
    ? Number(args.waitSecs)
    : 25;
  if (Number.isNaN(waitSecs)) waitSecs = 25;
  waitSecs = Math.min(600, Math.max(0, waitSecs));

  // Fast check before waiting: expire a stale approval first so its expiry
  // answer is what gets returned; if the ticket doesn't exist anywhere, fail.
  expireStalePending(id);
  const initialFound = findResponse(id);
  if (!initialFound && !requestLocation(id)) {
    return toolResult('Unknown ticket id ' + id + ': no request or answer file exists for it in the relay folders.', true);
  }

  const outcome = await waitForResponseOrTimeout(
    id,
    waitSecs * 1000,
    reqState,
    (elapsedSecs) => {
      if (reqState && reqState.progressToken !== undefined && reqState.progressToken !== null) {
        sendProgress(reqState.progressToken, elapsedSecs, waitSecs, 'Waiting for Muse ticket ' + id + ' (' + elapsedSecs + 's)...');
      }
    }
  );

  if (outcome.cancelled) return null;
  if (outcome.found) {
    if (!outcome.found.partial && outcome.found.data && typeof outcome.found.data.answer === 'string') {
      consumeResponse(id, outcome.found);
      return toolResult(outcome.found.data.answer, false);
    }
    if ((Date.now() - (outcome.found.mtimeMs || 0)) <= PARTIAL_WRITE_GRACE_MS) {
      return toolResult('PENDING: answer for request ' + id + ' is currently arriving in the outbox. Call ask_muse_check again shortly.', false);
    }
    return toolResult('Muse returned an unreadable answer file for request ' + id + '.', true);
  }

  // The wait may have crossed the approval TTL: expire and re-check once.
  if (expireStalePending(id)) {
    const expired = findResponse(id);
    if (expired && !expired.partial && expired.data && typeof expired.data.answer === 'string') {
      consumeResponse(id, expired);
      return toolResult(expired.data.answer, false);
    }
  }

  const pending = pendingText(id, waitSecs);
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

function sendProgress(progressToken, progress, total, message) {
  send({
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: {
      progressToken: progressToken,
      progress: progress,
      total: total,
      message: message
    }
  });
}

async function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  const method = msg.method;
  const id = msg.id;
  const isNotification = id === undefined || id === null;

  if (typeof method !== 'string') {
    if (!isNotification) {
      replyError(id, -32600, 'Invalid Request: missing method');
    }
    return;
  }

  if (method === 'initialize') {
    const clientProtocol = msg.params && msg.params.protocolVersion;
    const negotiatedProtocol = (clientProtocol && SUPPORTED_PROTOCOLS.has(clientProtocol))
      ? clientProtocol
      : (clientProtocol || DEFAULT_PROTOCOL);
    reply(id, {
      protocolVersion: negotiatedProtocol,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
    });
    return;
  }

  if (method === 'notifications/cancelled' || method === '$/cancelRequest') {
    const targetId = msg.params && (msg.params.requestId !== undefined ? msg.params.requestId : msg.params.id);
    if (targetId !== undefined && targetId !== null) {
      const state = activeRequests.get(String(targetId));
      if (state) {
        state.cancelled = true;
        if (Array.isArray(state.onCancel)) {
          state.onCancel.forEach((fn) => { try { fn(); } catch (_) {} });
        }
      }
    }
    return;
  }

  if (isNotification) return; // notifications/initialized, ...

  if (method === 'ping') { reply(id, {}); return; }
  if (method === 'tools/list') { reply(id, { tools: TOOLS }); return; }

  // Graceful empty responses for optional discovery methods queried by some MCP clients
  if (method === 'resources/list') { reply(id, { resources: [] }); return; }
  if (method === 'resources/templates/list') { reply(id, { resourceTemplates: [] }); return; }
  if (method === 'prompts/list') { reply(id, { prompts: [] }); return; }
  if (method === 'logging/setLevel') { reply(id, {}); return; }

  if (method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    const meta = (msg.params && msg.params._meta) || {};
    const reqKey = String(id);
    const reqState = {
      cancelled: false,
      onCancel: [],
      progressToken: meta.progressToken
    };
    activeRequests.set(reqKey, reqState);
    try {
      if (name === 'ask_muse') {
        const res = await callAskMuse(args, reqState);
        if (!reqState.cancelled && res) reply(id, res);
        return;
      }
      if (name === 'ask_muse_start') {
        reply(id, callAskMuseStart(args));
        return;
      }
      if (name === 'ask_muse_check') {
        const res = await callAskMuseCheck(args, reqState);
        if (!reqState.cancelled && res) reply(id, res);
        return;
      }
      replyError(id, -32602, 'Unknown tool: ' + name);
      return;
    } catch (e) {
      if (!reqState.cancelled) {
        reply(id, toolResult('muse-relay server error: ' + (e && e.message ? e.message : String(e)), true));
      }
      return;
    } finally {
      activeRequests.delete(reqKey);
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

// Clean shutdown when the host closes stdio so no zombie polling loop survives
function cleanExit() {
  for (const state of activeRequests.values()) {
    state.cancelled = true;
    if (Array.isArray(state.onCancel)) {
      state.onCancel.forEach((fn) => { try { fn(); } catch (_) {} });
    }
  }
  process.exit(0);
}
rl.on('close', cleanExit);
process.stdin.on('end', cleanExit);
process.on('SIGTERM', cleanExit);
process.on('SIGINT', cleanExit);
