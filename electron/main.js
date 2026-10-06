/*
 * PlayCS Offline — Electron 主进程 (main.js)
 * ============================================================
 * 零 npm 依赖:HTTP 静态服务 + API stub + WS 联机中继 全部用 Node 内置模块实现,
 * 与 Python 版 playcs_server.py 行为一致。
 *
 * 双击 PlayCS.exe 后:
 *   1. 启动本地服务(默认 http://127.0.0.1:8787, 被占用自动顺延)
 *   2. 打开游戏窗口加载大厅(沙箱窗口/拦截浏览器快捷键/性能优化)
 *   3. 玩家点地图即玩 —— 无需任何配置
 *
 * 特殊用法:
 *   PlayCS.exe --serve-only        只启动本地服务不开窗口(做局域网游戏服务器/中继时用)
 *   PlayCS.exe --port 9000         指定端口
 *   PlayCS.exe --kiosk             全屏启动
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const dgram = require('dgram');
const net = require('net');

// Electron 注入口(纯 Node 测试时 undefined → 走 serve-only)
let electronExports;
try { electronExports = require('electron'); } catch (e) { electronExports = undefined; }

// ------------------------------------------------------------ 路径
// 打包结构: <root>/PlayCS.exe  <root>/resources/app/main.js  <root>/resources/web/<游戏文件>
const CANDIDATES = [
  path.join(__dirname, '..', 'web'),       // 打包布局: resources/app → resources/web
  path.join(__dirname, '..'),              // 源码布局: electron/ → playcs-offline/
  path.join(__dirname, 'web'),
  path.join(__dirname, '..', '..', 'web'),
  __dirname,
];
let WEBROOT = CANDIDATES.find(p => fs.existsSync(path.join(p, 'play.html')));
if (!WEBROOT) WEBROOT = CANDIDATES[0];
const DATA_DIR = path.join(WEBROOT, 'playcs_data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

const MIME = {
  '.wasm': 'application/wasm', '.data': 'application/octet-stream',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.html': 'text/html', '.htm': 'text/html', '.txt': 'text/plain',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.xml': 'application/xml', '.map': 'application/json', '.so': 'application/wasm',
  '.dll': 'application/octet-stream', '.exe': 'application/octet-stream',
  '.zip': 'application/zip', '.cfg': 'text/plain', '.bsp': 'application/octet-stream',
};

function log(msg) { console.log(msg); }

// ------------------------------------------------------------ HTTP 工具
function sendBuf(res, code, headers, body) {
  res.writeHead(code, headers);
  res.end(body);
}
function json(res, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  sendBuf(res, 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
  }, body);
}
function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// ------------------------------------------------------------ 账号存储(与 Python 版同构)
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const ACHIEVE_FILE = path.join(DATA_DIR, 'achievements_local.json');
const fileLock = { _q: Promise.resolve() };
function withLock(fn) {
  const run = fileLock._q.then(fn).catch(e => { throw e; });
  fileLock._q = run.catch(() => {});
  return run;
}
function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); }
  catch (e) { return { accounts: {}, tokens: {} }; }
}
function saveAccounts(db) { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(db, null, 2)); }
function hashPw(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.pbkdf2Sync(pw, Buffer.from(salt, 'hex'), 120000, 32, 'sha256').toString('hex');
  return { salt, hash: h };
}
function publicUser(a) {
  return { id: a.id, username: a.username, displayName: a.displayName, email: a.email,
           avatarUrl: a.avatarUrl || null, avatarUpdatedAt: a.avatarUpdatedAt || null };
}
function sessionPayload(a) {
  return { ok: true, user: publicUser(a), accessToken: a.accessToken,
           profile: a.profile || { profileLevel: 1, xpInLevel: 0, xpToNext: 500 },
           loadout: a.loadout || {}, rewardActivity: a.rewardActivity || [],
           achievementsSummary: a.achievementsSummary || null, pendingRewardNotices: [] };
}
function userByToken(token) {
  if (!token) return null;
  const db = loadAccounts();
  const email = db.tokens && db.tokens[token];
  return email ? db.accounts[email] : null;
}

// ------------------------------------------------------------ 联机中继(WS ↔ UDP/TCP 桥)
// 协议: /websocket/u/<host>:<port>  UDP 桥(默认)
//       /websocket/t/<host>:<port>  TCP 桥
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_TEXT = 0x1, OP_BIN = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xA;

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID, 'binary').digest('base64');
}
function parseRelayPath(p) {
  const clean = p.split('?')[0];
  const parts = clean.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < 3 || parts[0] !== 'websocket') return null;
  const mode = parts[1].toLowerCase();
  if (mode !== 'u' && mode !== 't') return null;
  const target = parts.slice(2).join('/');
  const idx = target.lastIndexOf(':');
  if (idx < 0) return null;
  const host = target.slice(0, idx).replace(/^\[|\]$/g, '');
  const port = parseInt(target.slice(idx + 1), 10);
  if (!host || !port) return null;
  return { mode, host, port };
}

// WS 连接封装(服务端, 发送不掩码)
class WSConn {
  constructor(socket) {
    this.sock = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;
  }
  feed(data) { this.buf = Buffer.concat([this.buf, data]); }
  // 逐条取出完整消息; 数据不足返回 null; 帧过大返回 undefined(已 close)
  readMessage() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = b[0] & 0x80;
    const opcode = b[0] & 0x0f;
    const masked = b[1] & 0x80;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < off + 2) return null; len = b.readUInt16BE(off); off += 2; }
    else if (len === 127) { if (b.length < off + 8) return null; len = Number(b.readBigUInt64BE(off)); off += 8; }
    if (len > 16 * 1024 * 1024) { this.close(1009); return undefined; }
    let mask = null;
    if (masked) { if (b.length < off + 4) return null; mask = b.slice(off, off + 4); off += 4; }
    if (b.length < off + len) return null;
    let payload = b.slice(off, off + len);
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = b.slice(off + len);
    return { fin, opcode, payload };
  }
  send(opcode, payload) {
    if (this.closed) return;
    const n = payload.length;
    let hdr;
    if (n < 126) hdr = Buffer.from([0x80 | opcode, n]);
    else if (n < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x80 | opcode; hdr[1] = 126; hdr.writeUInt16BE(n, 2); }
    else { hdr = Buffer.alloc(10); hdr[0] = 0x80 | opcode; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(n), 2); }
    try { this.sock.write(Buffer.concat([hdr, payload])); } catch (e) {}
  }
  close(code) {
    if (this.closed) return;
    this.closed = true;
    const b = Buffer.alloc(2); b.writeUInt16BE(code || 1000);
    this.send(OP_CLOSE, b);
    try { this.sock.end(); } catch (e) {}
  }
}

function bridgeWSUDP(ws, host, port) {
  const udp = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
  udp.on('message', (data) => { ws.send(OP_BIN, data); });
  udp.on('error', () => { ws.close(1011); });
  udp.bind(() => { log(`[relay] UDP bridge → ${host}:${port}`); });
  ws.onmessage = (payload) => {
    try { udp.send(payload, port, host); } catch (e) { /* UDP 语义: 静默丢弃 */ }
  };
  ws.onclose = () => { try { udp.close(); } catch (e) {} };
}

function bridgeWSTCP(ws, host, port) {
  const tcp = net.connect({ host, port });
  let up = false;
  tcp.on('connect', () => { up = true; log(`[relay] TCP bridge → ${host}:${port}`); });
  tcp.on('data', (data) => { ws.send(OP_BIN, data); });
  tcp.on('error', () => { ws.close(1011); });
  tcp.on('close', () => { ws.close(1000); });
  ws.onmessage = (payload) => { if (up) try { tcp.write(payload); } catch (e) {} };
  ws.onclose = () => { try { tcp.destroy(); } catch (e) {} };
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const parsed = parseRelayPath(req.url || '');
  if (!key || !parsed) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  const ws = new WSConn(socket);
  socket.on('data', (d) => {
    ws.feed(d);
    let msg;
    while ((msg = ws.readMessage()) !== null) {
      if (msg === undefined) return;
      if (msg.opcode === OP_CLOSE) { ws.close(1000); return; }
      if (msg.opcode === OP_PING) { ws.send(OP_PONG, msg.payload); continue; }
      if (msg.opcode === OP_PONG) continue;
      if ((msg.opcode === OP_BIN || msg.opcode === OP_TEXT) && msg.payload.length && ws.onmessage) {
        ws.onmessage(msg.payload);
      }
    }
  });
  socket.on('error', () => { ws.closed = true; });
  socket.on('close', () => { ws.closed = true; if (ws.onclose) ws.onclose(); });
  if (parsed.mode === 't') bridgeWSTCP(ws, parsed.host, parsed.port);
  else bridgeWSUDP(ws, parsed.host, parsed.port);
}

// ------------------------------------------------------------ 服务器列表配置
const SERVERS_FILE = path.join(WEBROOT, 'offline-servers.json');
function loadServersFile() {
  try { return JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8')); }
  catch (e) { return { servers: [] }; }
}
function serverPayload(s, sid) {
  return {
    id: sid, name: s.name || sid, connect: s.connect || '',
    map: s.map || '', mode: s.mode || 'classic', wsProxyUrl: s.wsProxyUrl || '',
    players: s.players || 0, maxPlayers: s.maxPlayers || 32,
    official: !!s.official,
  };
}

// ------------------------------------------------------------ API 路由
async function handleApi(req, res, pathname, q) {
  if (pathname === '/api/auth/config')
    return json(res, { ok: true, registration: { enabled: true }, turnstile: { enabled: false }, announcement: null, xpEvent: null });
  if (pathname === '/api/game/skin-chunks') {
    const chunks = ['weapon_skins', 'savior', 'zemod', 'hideandseek', 'hud']
      .filter(n => fs.existsSync(path.join(WEBROOT, 'chunks', n + '.data')))
      .map(n => ({ url: 'chunks/' + n + '.data' }));
    return json(res, { ok: true, chunks });
  }
  if (pathname === '/api/game/asset-versions')
    return json(res, { ok: true, defaultVersion: '', versions: {} });
  if (pathname === '/api/servers') {
    const conf = loadServersFile();
    if (q.get('connect')) {
      return json(res, { ok: true, servers: [serverPayload({
        name: q.get('name') || 'Quick connect', connect: q.get('connect'),
        map: q.get('map') || '', wsProxyUrl: q.get('ws') || '', }, 'dynamic')] });
    }
    return json(res, { ok: true, servers: conf.servers.map((s, i) => serverPayload(s, s.id || String(i))) });
  }
  if (pathname.startsWith('/api/servers/')) {
    const sid = decodeURIComponent(pathname.slice('/api/servers/'.length));
    const conf = loadServersFile();
    let srv = conf.servers.find(s => (s.id || '') === sid);
    if (!srv && q.get('connect'))
      srv = { name: q.get('name') || sid, connect: q.get('connect'), map: q.get('map') || '', wsProxyUrl: q.get('ws') || '' };
    if (!srv) return json(res, { ok: false, errorKey: 'servers.notFound' });
    return json(res, { ok: true, server: serverPayload(srv, sid) });
  }
  if (pathname === '/api/achievements/me') {
    let d = { unlocked: [], summary: {} };
    try { d = JSON.parse(fs.readFileSync(ACHIEVE_FILE, 'utf8')); } catch (e) {}
    return json(res, { ok: true, unlocked: d.unlocked || [], summary: d.summary || {} });
  }
  if (pathname === '/api/achievements/sync') {
    const b = await readBody(req);
    try { fs.writeFileSync(ACHIEVE_FILE, JSON.stringify(b)); } catch (e) {}
    return json(res, { ok: true, unlocked: b.unlocked || [], summary: b.summary || {} });
  }
  if (pathname === '/api/achievements/catalog') {
    try {
      const cat = JSON.parse(fs.readFileSync(path.join(WEBROOT, 'data', 'achievements-i18n.json'), 'utf8'));
      return json(res, { ok: true, groups: cat.groups || {}, entries: cat.entries || {} });
    } catch (e) { return json(res, { ok: true, groups: {}, entries: {} }); }
  }
  if (pathname === '/api/auth/me') {
    const acc = userByToken((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!acc) return json(res, { ok: false, errorKey: 'auth.error.notLoggedIn' });
    return json(res, sessionPayload(acc));
  }
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const b = await readBody(req);
    const email = (b.email || '').trim().toLowerCase();
    const display = (b.displayName || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, { ok: false, errorKey: 'auth.error.emailInvalid' });
    if (!display) return json(res, { ok: false, errorKey: 'auth.error.nicknameInvalid' });
    if (!b.password || b.password.length < 6) return json(res, { ok: false, errorKey: 'auth.error.passwordShort' });
    return withLock(() => {
      const db = loadAccounts();
      if (db.accounts[email]) return json(res, { ok: false, errorKey: 'auth.error.emailExists' });
      const { salt, hash } = hashPw(b.password);
      const acc = { id: 1 + Math.max(0, ...Object.values(db.accounts).map(a => a.id || 0)),
                    email, username: display, displayName: display, salt, passwordHash: hash,
                    profile: { profileLevel: 1, xpInLevel: 0, xpToNext: 500 }, inventory: [], loadout: {}, rewardActivity: [] };
      acc.accessToken = 'local-' + crypto.randomBytes(24).toString('hex');
      db.accounts[email] = acc; db.tokens[acc.accessToken] = email;
      saveAccounts(db);
      return json(res, sessionPayload(acc));
    });
  }
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const b = await readBody(req);
    const email = (b.email || '').trim().toLowerCase();
    const db = loadAccounts();
    const acc = db.accounts[email];
    if (!acc) return json(res, { ok: false, errorKey: 'auth.error.invalidCredentials' });
    const { hash } = hashPw(b.password || '', acc.salt);
    if (hash !== acc.passwordHash) return json(res, { ok: false, errorKey: 'auth.error.invalidCredentials' });
    return json(res, sessionPayload(acc));
  }
  return json(res, { ok: true });
}

// ------------------------------------------------------------ HTTP 服务器
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  let fp = path.normalize(path.join(WEBROOT, pathname));
  if (!fp.startsWith(WEBROOT)) { res.writeHead(403); return res.end(); }
  fs.stat(fp, (err, st) => {
    if (!err && st.isDirectory()) fp = path.join(fp, 'index.html');
    fs.stat(fp, (err2, st2) => {
      if (err2 || !st2.isFile()) {
        return sendBuf(res, 404, { 'Content-Type': 'text/plain' }, 'Not Found');
      }
      const ext = path.extname(fp).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      const size = st2.size;
      const range = req.headers.range;
      const baseHeaders = {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=3600',
      };
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
        if (isNaN(start) || start < 0) start = 0;
        if (isNaN(end) || end >= size) end = size - 1;
        if (start > end || start >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          return res.end();
        }
        res.writeHead(206, Object.assign(baseHeaders, {
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': end - start + 1,
        }));
        fs.createReadStream(fp, { start, end }).pipe(res);
      } else {
        res.writeHead(200, Object.assign(baseHeaders, { 'Content-Length': size }));
        const stream = fs.createReadStream(fp);
        stream.on('error', () => { try { res.destroy(); } catch (e) {} });
        stream.pipe(res);
      }
    });
  });
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(u.pathname);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }
    if (pathname.startsWith('/api/')) {
      try { return await handleApi(req, res, pathname, u.searchParams); }
      catch (e) { return json(res, { ok: false, error: String(e) }); }
    }
    serveStatic(req, res, pathname);
  });
  server.on('upgrade', handleUpgrade);
  return server;
}

// ------------------------------------------------------------ 端口选择
function pickPort(start) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(pickPort(start + 1)));
    probe.once('listening', () => probe.close(() => resolve(start)));
    probe.listen(start, '0.0.0.0');
  });
}

// ------------------------------------------------------------ 启动
async function main() {
  const args = process.argv.slice(2);
  const serveOnly = args.includes('--serve-only');
  const kiosk = args.includes('--kiosk');
  const portIdx = args.indexOf('--port');
  const wanted = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 8787;
  const port = await pickPort(isNaN(wanted) ? 8787 : wanted);

  const server = createServer();
  await new Promise(r => server.listen(port, '0.0.0.0', r));
  const lanIp = (() => {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const it of ifs[name] || []) {
        if (it.family === 'IPv4' && !it.internal) return it.address;
      }
    }
    return '127.0.0.1';
  })();
  log('PlayCS Offline 服务已启动');
  log(`  本机访问 :  http://127.0.0.1:${port}/`);
  log(`  局域网   :  http://${lanIp}:${port}/  (其他设备可打开一起设置联机)`);
  log(`  联机中继 :  ws://127.0.0.1:${port}/websocket/u/<服务器IP>:<端口>`);
  log(`  资源目录 :  ${WEBROOT}`);

  if (serveOnly || !electronExports || !electronExports.app) {
    log('--serve-only 模式 (Ctrl+C 停止)');
    return;
  }

  // ---- Electron 窗口 ----
  const { app, BrowserWindow, Menu, shell } = electronExports;
  Menu.setApplicationMenu(null);

  // 性能开关
  app.commandLine.appendSwitch('disable-frame-rate-limit');
  app.commandLine.appendSwitch('disable-gpu-vsync');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { app.quit(); return; }

  app.whenReady().then(() => {
    const win = new BrowserWindow({
      width: 1600, height: 900,
      minWidth: 1024, minHeight: 640,
      title: 'PlayCS Offline — Counter-Strike: Source',
      backgroundColor: '#0b0e14',
      autoHideMenuBar: true,
      kiosk: !!kiosk,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webgl: true,
        powerPreference: 'high-performance',
      },
    });
    // 拦截浏览器快捷键(避免干扰游戏操作;保留 F5/F11/F12)
    const BLOCK = new Set(['t', 'n', 'l', 'j', 'p', 's', 'u', 'q', 'd', 'f', 'tab']);
    win.webContents.on('before-input-event', (ev, input) => {
      if (input.type !== 'keyDown') return;
      const k = (input.key || '').toLowerCase();
      const mod = input.control || input.meta;
      if (k === 'f5' || k === 'f11' || k === 'f12') return;
      if (mod && k === 'r') { ev.preventDefault(); win.webContents.reload(); return; }
      if (mod && BLOCK.has(k)) { ev.preventDefault(); return; }
    });
    // 外部链接走系统浏览器
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith(`http://127.0.0.1:${port}`) && !url.startsWith(`http://localhost:${port}`))
        shell.openExternal(url);
      return { action: 'deny' };
    });
    win.loadURL(`http://127.0.0.1:${port}/index.html`);
    win.on('closed', () => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
