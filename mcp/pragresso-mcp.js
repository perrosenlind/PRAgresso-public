#!/usr/bin/env node
/* eslint-env node */
// PRAgresso MCP bridge — one zero-dependency script, three modes:
//
//   node pragresso-mcp.js                 MCP server on stdio. This is what an
//                                         AI agent launches (Claude Code,
//                                         Claude Desktop, any MCP client).
//   node pragresso-mcp.js native …        Chrome Native Messaging host.
//                                         Chrome launches this itself when the
//                                         extension connects; never run it by
//                                         hand.
//   node pragresso-mcp.js install --extension-id <id>
//                                         Registers the native host with
//                                         Chrome for this user.
//
// The two processes meet on a local socket only this user can open
// (~/.pragresso/mcp.sock, or a named pipe on Windows):
//
//   agent ⇄ stdio ⇄ [MCP server] ⇄ socket ⇄ [native host] ⇄ Chrome ⇄ extension
//
// Nothing listens on the network. The extension decides what each tool may
// do; this script only relays. Submitting a time report is deliberately not
// a tool at all.

'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const HOST_NAME = 'se.pragresso.mcp';
const VERSION = '1.11.0';
const STATE_DIR = path.join(os.homedir(), '.pragresso');
const SOCKET_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\pragresso-mcp-' + os.userInfo().username
  : path.join(STATE_DIR, 'mcp.sock');
const CALL_TIMEOUT_MS = 60000;

const log = (...a) => { try { process.stderr.write('[pragresso-mcp] ' + a.join(' ') + '\n'); } catch (e) { /* ignore */ } };

// ── Tool catalogue ─────────────────────────────────────────────────────────
// Kept here (not fetched from the extension) so `tools/list` answers even
// while Chrome is closed; calls then fail with a clear message instead.
const TOOLS = [
  {
    name: 'get_timesheet',
    description: 'Read the Agresso time report open in the browser: period, status, each day with its date and the hours still to register, and every Tidtransaktion row (Delproj code and name, Aktivitet, description, hours per day, Sum, Fakt. värde, whether billed hours were adjusted). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_library',
    description: 'List the Delproj codes in the PRAgresso library: codes the user has reported on before (with name, last week used and number of weeks) and codes the user added by hand. Use it to pick the right Delproj for a task. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Optional filter on code or name (case-insensitive substring).' } },
      additionalProperties: false
    }
  },
  {
    name: 'add_library_code',
    description: 'Add a Delproj code to the PRAgresso library as the user\'s own entry, with an optional name or note. Does not touch the time report.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string' }, name: { type: 'string' } },
      required: ['code'],
      additionalProperties: false
    }
  },
  {
    name: 'add_row',
    description: 'Add a Tidtransaktion row to the open time report and fill it in, exactly as typing it would: Delproj, Aktivitet, Beskrivningstext and hours per day. Codes are set EXACTLY (Agresso\'s own first-match lookup is overridden) and verified by Agresso; any code the row cannot use is reported under `problems`. The row is NOT saved — call save_timesheet afterwards when the user wants it saved. Get valid days from get_timesheet and Delproj codes from list_library.',
    inputSchema: {
      type: 'object',
      properties: {
        delproj: { type: 'string', description: 'Delproj code, e.g. 123456-7.' },
        activity: { type: 'string', description: 'Aktivitet code, e.g. SPE.' },
        description: { type: 'string', description: 'Beskrivningstext.' },
        hours: { type: 'object', description: 'Hours per day keyed by dd/mm, e.g. {"04/11": 2, "05/11": 1.5}.', additionalProperties: { type: 'number' } },
        timecode: { type: 'string', description: 'Tidkod; defaults to Agresso\'s own default (N, normal working time).' }
      },
      required: ['delproj'],
      additionalProperties: false
    }
  },
  {
    name: 'update_row',
    description: 'Change an existing Tidtransaktion row (by its `row` number from get_timesheet): any of Delproj, Aktivitet, Beskrivningstext or hours per day. Hours given replace that day\'s value; days not given are left alone. Not saved — call save_timesheet afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        row: { type: 'integer', minimum: 0 },
        delproj: { type: 'string' },
        activity: { type: 'string' },
        description: { type: 'string' },
        hours: { type: 'object', additionalProperties: { type: 'number' } },
        timecode: { type: 'string' }
      },
      required: ['row'],
      additionalProperties: false
    }
  },
  {
    name: 'save_timesheet',
    description: 'Save the open Agresso time report (the same as pressing Spara). It does NOT submit or send the report for approval — that is always left to the user. Call get_timesheet afterwards to confirm the result.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

// ── Socket client (used by the MCP server) ─────────────────────────────────
function callBridge(tool, args) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET_PATH);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('Timed out waiting for the browser (60 s).')); }, CALL_TIMEOUT_MS);
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, tool, args: args || {} }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      sock.end();
      try {
        const msg = JSON.parse(buf.slice(0, nl));
        if (msg.ok) resolve(msg.result);
        else reject(new Error(msg.error || 'The extension reported an error.'));
      } catch (e) { reject(e); }
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
        ? 'PRAgresso is not connected: open Chrome with an Agresso tab and turn on "Allow AI agents (MCP)" in the PRAgresso options.'
        : e.message));
    });
  });
}

// ── MCP server over stdio (newline-delimited JSON-RPC 2.0) ─────────────────
function runMcpServer() {
  let buf = '';
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'pragresso', version: VERSION },
        instructions: 'Tools for the Agresso time report open in the user\'s Chrome. Read with get_timesheet before changing anything, prefer Delproj codes from list_library, check `problems` after add_row / update_row, save only when the user wants it saved, and never claim a report was submitted: submitting is not possible through these tools.'
      });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = params && params.name;
      if (!TOOLS.some((t) => t.name === name)) return fail(id, -32602, `Unknown tool: ${name}`);
      try {
        const result = await callBridge(name, (params && params.arguments) || {});
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: e.message }], isError: true });
      }
    }
    if (id === undefined || id === null) return; // notifications
    return fail(id, -32601, `Method not found: ${method}`);
  }

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { fail(null, -32700, 'Parse error'); continue; }
      handle(msg).catch((e) => fail(msg.id ?? null, -32603, e.message));
    }
  });
}

// ── Native Messaging host (launched by Chrome) ─────────────────────────────
// Chrome frames every message as a 4-byte little-endian length + UTF-8 JSON.
function runNativeHost() {
  const pending = new Map(); // id → socket
  let nextId = 1;
  let inBuf = Buffer.alloc(0);

  const toChrome = (obj) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    process.stdout.write(Buffer.concat([head, body]));
  };

  process.stdin.on('data', (chunk) => {
    inBuf = Buffer.concat([inBuf, chunk]);
    while (inBuf.length >= 4) {
      const len = inBuf.readUInt32LE(0);
      if (inBuf.length < 4 + len) break;
      const body = inBuf.slice(4, 4 + len).toString('utf8');
      inBuf = inBuf.slice(4 + len);
      let msg;
      try { msg = JSON.parse(body); } catch (e) { continue; }
      if (msg && msg.type === 'result' && pending.has(msg.id)) {
        const sock = pending.get(msg.id);
        pending.delete(msg.id);
        try { sock.end(JSON.stringify({ ok: !!msg.ok, result: msg.result, error: msg.error }) + '\n'); } catch (e) { /* ignore */ }
      }
    }
  });
  // Chrome closed the port (extension disabled, option turned off, browser
  // quit): stop listening so a stale socket never answers for a dead tab.
  process.stdin.on('end', () => { cleanup(); process.exit(0); });

  if (process.platform !== 'win32') {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    try { fs.unlinkSync(SOCKET_PATH); } catch (e) { /* none */ }
  }
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let req;
      try { req = JSON.parse(buf.slice(0, nl)); } catch (e) { sock.end(JSON.stringify({ ok: false, error: 'Bad request' }) + '\n'); return; }
      const id = nextId++;
      pending.set(id, sock);
      toChrome({ type: 'call', id, tool: String(req.tool || ''), args: req.args || {} });
    });
    sock.on('close', () => { for (const [k, v] of pending) if (v === sock) pending.delete(k); });
    sock.on('error', () => { /* client went away */ });
  });
  server.listen(SOCKET_PATH, () => {
    if (process.platform !== 'win32') { try { fs.chmodSync(SOCKET_PATH, 0o600); } catch (e) { /* ignore */ } }
    toChrome({ type: 'hello', version: VERSION });
    log('native host listening on', SOCKET_PATH);
  });
  function cleanup() {
    try { server.close(); } catch (e) { /* ignore */ }
    if (process.platform !== 'win32') { try { fs.unlinkSync(SOCKET_PATH); } catch (e) { /* ignore */ } }
  }
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}

// ── Installer ──────────────────────────────────────────────────────────────
function runInstall(argv) {
  const i = argv.indexOf('--extension-id');
  const extId = i >= 0 ? argv[i + 1] : '';
  if (!/^[a-p]{32}$/.test(extId || '')) {
    console.error('Usage: node pragresso-mcp.js install --extension-id <id>\n' +
      'The id is shown under "Allow AI agents (MCP)" on the PRAgresso options page (32 letters a–p).');
    process.exit(2);
  }
  const script = path.resolve(__filename);
  // Pin a node binary that survives upgrades: Homebrew's process.execPath is
  // a versioned Cellar path (…/Cellar/node/26.13.0_2/bin/node) that vanishes
  // on the next `brew upgrade`, so prefer the stable symlink next to it.
  let nodeBin = process.execPath;
  const cellar = nodeBin.match(/^(.*)\/Cellar\/node[^/]*\/[^/]+\/bin\/node$/);
  if (cellar && fs.existsSync(path.join(cellar[1], 'bin', 'node'))) nodeBin = path.join(cellar[1], 'bin', 'node');
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  let hostPath;
  if (process.platform === 'win32') {
    hostPath = path.join(STATE_DIR, 'native-host.cmd');
    fs.writeFileSync(hostPath, `@echo off\r\n"${nodeBin}" "${script}" native %*\r\n`);
  } else {
    // Chrome starts the host with a minimal PATH, so pin the node binary
    // that ran the installer instead of relying on `#!/usr/bin/env node`.
    hostPath = path.join(STATE_DIR, 'native-host.sh');
    fs.writeFileSync(hostPath, `#!/bin/sh\nexec "${nodeBin}" "${script}" native "$@"\n`, { mode: 0o755 });
  }
  const manifest = {
    name: HOST_NAME,
    description: 'PRAgresso MCP bridge',
    path: hostPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extId}/`]
  };
  const home = os.homedir();
  const dirs = {
    darwin: [
      path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
      path.join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts')
    ],
    linux: [
      path.join(home, '.config/google-chrome/NativeMessagingHosts'),
      path.join(home, '.config/chromium/NativeMessagingHosts')
    ],
    win32: [STATE_DIR]
  }[process.platform] || [];
  const written = [];
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${HOST_NAME}.json`);
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
      written.push(file);
    } catch (e) { log('skipped', dir, e.message); }
  }
  if (process.platform === 'win32' && written[0]) {
    const { execFileSync } = require('child_process');
    for (const key of ['HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + HOST_NAME,
      'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\' + HOST_NAME]) {
      try { execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', written[0], '/f'], { stdio: 'ignore' }); } catch (e) { log('reg add failed for', key); }
    }
  }
  console.log('Native host registered:\n  ' + written.join('\n  '));
  console.log('\nAdd this MCP server to your agent, e.g. for Claude Code:\n' +
    `  claude mcp add -s user pragresso -- "${nodeBin}" "${script}"\n` +
    'Then reload the extension and turn on "Allow AI agents (MCP)" in the PRAgresso options.');
}

const mode = process.argv[2];
if (mode === 'native' || (mode && mode.startsWith('chrome-extension://'))) runNativeHost();
else if (mode === 'install') runInstall(process.argv.slice(3));
else runMcpServer();
