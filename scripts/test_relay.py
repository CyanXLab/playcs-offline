#!/usr/bin/env python3
"""ws_relay + 服务器 API 的自测(同块内启动/验证/停止)。"""
import base64
import json
import os
import socket
import struct
import sys
import threading
import time
import urllib.request
from hashlib import sha1

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'playcs-offline'))
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'playcs-offline'))

import ws_relay
from ws_relay import _accept_key, ws_read_message, ws_send_frame, OP_BIN

import playcs_server
from playcs_server import ApiHandler, StaticHandler
from http.server import ThreadingHTTPServer

# ---- 启动两个端口 ----
static_srv = ThreadingHTTPServer(('127.0.0.1', 18000), StaticHandler)
api_srv = ThreadingHTTPServer(('127.0.0.1', 18787), ApiHandler)
for s in (static_srv, api_srv):
    s.daemon_threads = True
    threading.Thread(target=s.serve_forever, daemon=True).start()
time.sleep(0.3)

results = []

# ---- 1. HTTP API 测试 ----
r = urllib.request.urlopen('http://127.0.0.1:18787/api/game/skin-chunks')
d = json.loads(r.read())
results.append(('skin-chunks', d.get('ok') and isinstance(d.get('chunks'), list)))

r = urllib.request.urlopen('http://127.0.0.1:18787/api/servers/lan-example')
d = json.loads(r.read())
results.append(('servers/{id} from file', d.get('ok') and d['server']['connect'] == '192.168.1.100:27015'))

r = urllib.request.urlopen('http://127.0.0.1:18787/api/servers/dyn?connect=10.0.0.5%3A27015&map=de_nuke')
d = json.loads(r.read())
results.append(('servers/{id} dynamic', d.get('ok') and d['server']['connect'] == '10.0.0.5:27015'))

# ---- 2. 中继握手(经静态端口) ----
# 起一个 UDP echo 服务器模拟游戏服务器
udp_srv = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
udp_srv.bind(('127.0.0.1', 0))
udp_port = udp_srv.getsockname()[1]


def udp_echo():
    while True:
        data, addr = udp_srv.recvfrom(65535)
        udp_srv.sendto(b'ACK:' + data, addr)  # 回包到源(= 中继的 UDP socket)


threading.Thread(target=udp_echo, daemon=True).start()

# 原生 socket 做 WS 握手 + 收发
c = socket.create_connection(('127.0.0.1', 18000), timeout=5)
key = base64.b64encode(os.urandom(16)).decode()
c.sendall((
    f'GET /websocket/u/127.0.0.1:{udp_port} HTTP/1.1\r\n'
    'Host: 127.0.0.1\r\n'
    'Upgrade: websocket\r\n'
    'Connection: Upgrade\r\n'
    f'Sec-WebSocket-Key: {key}\r\n'
    'Sec-WebSocket-Version: 13\r\n'
    'Sec-WebSocket-Protocol: binary\r\n\r\n').encode())
resp = b''
while b'\r\n\r\n' not in resp:
    resp += c.recv(4096)
head = resp.split(b'\r\n\r\n')[0].decode()
expect = _accept_key(key)
results.append(('WS handshake 101', '101' in head and expect in head))

rfile = c.makefile('rb')

def client_send_frame(opcode, payload):
    mask = os.urandom(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    n = len(payload)
    hdr = bytes([0x80 | opcode])
    if n < 126:
        hdr += bytes([0x80 | n])
    else:
        hdr += bytes([0x80 | 126]) + struct.pack('>H', n)
    c.sendall(hdr + mask + masked)

client_send_frame(OP_BIN, b'PING1')
# 读 echo 回包
op, payload = ws_read_message(rfile)
results.append(('UDP echo via WS bridge', payload == b'ACK:PING1'))

# 连续 3 个数据报保持边界
for i in range(3):
    client_send_frame(OP_BIN, f'msg{i}'.encode())
ok = all(ws_read_message(rfile)[1] == f'ACK:msg{i}'.encode() for i in range(3))
results.append(('datagram boundary', ok))

# ---- 3. 中继错误路径(不存在的主机) ----
c2 = socket.create_connection(('127.0.0.1', 18000), timeout=5)
key2 = base64.b64encode(os.urandom(16)).decode()
c2.sendall((
    f'GET /websocket/u/240.0.0.1:5 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n'
    f'Connection: Upgrade\r\nSec-WebSocket-Key: {key2}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
r2 = b''
while b'\r\n\r\n' not in r2:
    r2 += c2.recv(4096)
results.append(('handshake always 101', b'101' in r2))
c2.close()

c.close()
udp_srv.close()
static_srv.shutdown()
api_srv.shutdown()

print()
allok = True
for name, ok in results:
    print(('  PASS  ' if ok else '  FAIL  ') + name)
    allok = allok and ok
print('\n==>', 'ALL PASS' if allok else 'SOME FAILED')
sys.exit(0 if allok else 1)
