#!/usr/bin/env node
/* 测试 electron/main.js 的服务器功能(纯 Node, 不开窗口) */
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const dgram = require('dgram');
const path = require('path');

const ROOT = '/home/z/my-project/download/playcs-offline';

function httpGet(port, p, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: headers || {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
function httpPost(port, p, obj) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(obj || {}));
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function wsTest(port, udpPort) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.get({
      host: '127.0.0.1', port,
      path: `/websocket/u/127.0.0.1:${udpPort}`,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13,
      },
    });
    req.on('upgrade', (res, socket) => {
      // 发一帧 masked binary "PING1" (客户端必须掩码)
      const payload = Buffer.from('PING1');
      const mask = crypto.randomBytes(4);
      const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
      const hdr = Buffer.from([0x82, 0x80 | payload.length]);
      socket.write(Buffer.concat([hdr, mask, masked]));
      socket.once('data', (d) => {
        // 解析服务端帧(无掩码)
        const op = d[0] & 0x0f;
        const len = d[1] & 0x7f;
        const text = d.slice(2, 2 + len).toString();
        socket.destroy();
        resolve({ op, text });
      });
    });
    req.on('error', reject);
    setTimeout(() => reject(new Error('ws timeout')), 5000);
  });
}

(async () => {
  const results = [];
  // 起一个 UDP echo
  const udp = dgram.createSocket('udp4');
  await new Promise(r => udp.bind(0, '127.0.0.1', r));
  const udpPort = udp.address().port;
  udp.on('message', (d, rinfo) => udp.send(Buffer.concat([Buffer.from('ACK:'), d]), rinfo.port, rinfo.address));

  const proc = spawn('node', [path.join(ROOT, 'electron', 'main.js'), '--serve-only', '--port', '18790'], { stdio: 'pipe' });
  let out = '';
  proc.stdout.on('data', d => out += d);
  proc.stderr.on('data', d => out += d);
  await new Promise(r => setTimeout(r, 1200));

  const base = 18790;
  let r = await httpGet(base, '/');
  results.push(['index served', r.status === 200 && r.headers['cross-origin-opener-policy'] === 'same-origin']);
  r = await httpGet(base, '/play.js');
  results.push(['play.js served', r.status === 200 && r.headers['content-type'] === 'text/javascript']);
  r = await httpGet(base, '/play.js', { Range: 'bytes=0-99' });
  results.push(['range 206', r.status === 206 && r.body.length === 100]);
  r = await httpGet(base, '/api/game/skin-chunks');
  results.push(['skin-chunks', JSON.parse(r.body).ok === true]);
  r = await httpGet(base, '/api/servers/lan-example');
  results.push(['servers/{id}', JSON.parse(r.body).server && JSON.parse(r.body).server.connect === '192.168.1.100:27015']);
  const reg = await httpPost(base, '/api/auth/register', { email: 'a@b.co', displayName: 'Tester', password: 'secret1' });
  results.push(['register', JSON.parse(reg.body).ok === true]);
  const login = await httpPost(base, '/api/auth/login', { email: 'a@b.co', password: 'secret1' });
  results.push(['login', JSON.parse(login.body).ok === true]);

  const wsres = await wsTest(base, udpPort);
  results.push(['WS→UDP bridge', wsres.op === 2 && wsres.text === 'ACK:PING1']);

  proc.kill();
  udp.close();

  let allok = true;
  for (const [name, ok] of results) { console.log((ok ? '  PASS  ' : '  FAIL  ') + name); allok = allok && ok; }
  console.log('\n==>', allok ? 'ALL PASS' : 'SOME FAILED');
  process.exit(allok ? 0 : 1);
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(2); });
