#!/usr/bin/env python3
"""
PLAYCS 离线版 - 内置 WS 中继网关 (ws_relay.py)
================================================
复刻 playcs.cc 官方网关(css.yikm.net)的传输层行为:

    引擎 socket(connect addr:port)
        → WebSocket 连接  <基址>/<addr>:<port>
        → 本中继建立到 addr:port 的真实 UDP(或 TCP)通道
        → 双向透传二进制帧

协议事实(逆向自 play.js / libengine.so):
    - 子协议: "binary";二进制帧即引擎 UDP/TCP 载荷
    - URL 路径: /websocket/u/<host>:<port>   (u = UDP 桥, 默认)
                /websocket/t/<host>:<port>   (t = TCP 桥)
    - UDP 模式下每个 WS 连接独占一个本地 UDP socket,
      服务器回包按来源地址回传到对应 WS。
    - DGRAM 首帧 "FF FF FF FF p o r t <hi> <lo>" 为引擎源端口宣告,
      仅作对端信息展示, 中继无需处理。

纯 Python 标准库实现(RFC 6455 服务端握手 + 帧编解码),
无任何第三方依赖;同时挂载在静态端口与 API 端口上,
页面无论从哪个端口打开都能就近使用内置中继。
"""
import base64
import errno
import hashlib
import socket
import struct
import threading

WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

OP_CONT, OP_TEXT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


def _accept_key(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()


def parse_relay_path(path: str):
    """解析 /websocket/<u|t>/<host>:<port> → ('u'|'t', host, port) 或 None"""
    parts = path.strip('/').split('/')
    if len(parts) < 3 or parts[0] != 'websocket':
        return None
    mode = parts[1].lower()
    target = '/'.join(parts[2:])  # host:port (host 可能含 v6 冒号, 简化取最后一段)
    if mode not in ('u', 't'):
        return None
    host, _, port = target.rpartition(':')
    if not host or not port.isdigit():
        return None
    port = int(port)
    host = host.strip('[]')
    return mode, host, port


# ---------------------------------------------------------------- 帧编解码

def _read_exact(rfile, n):
    buf = b''
    while len(buf) < n:
        chunk = rfile.read(n - len(buf))
        if not chunk:
            raise ConnectionError('ws: eof')
        buf += chunk
    return buf


def ws_read_message(rfile):
    """读取一条完整 WS 消息(处理分片), 返回 (opcode, payload bytes)。"""
    op0 = None
    payload = b''
    while True:
        b1, b2 = _read_exact(rfile, 2)
        fin = b1 & 0x80
        opcode = b1 & 0x0F
        masked = b2 & 0x80
        length = b2 & 0x7F
        if length == 126:
            (length,) = struct.unpack('>H', _read_exact(rfile, 2))
        elif length == 127:
            (length,) = struct.unpack('>Q', _read_exact(rfile, 8))
        if length > 16 * 1024 * 1024:
            raise ConnectionError('ws: frame too large')
        mask = _read_exact(rfile, 4) if masked else b'\x00\x00\x00\x00'
        data = _read_exact(rfile, length) if length else b''
        if masked:
            data = bytes(c ^ mask[i % 4] for i, c in enumerate(data))
        if op0 is None:
            op0 = opcode
        payload += data
        if fin or opcode in (OP_CLOSE, OP_PING, OP_PONG):
            return op0, payload


def ws_send_frame(wfile, opcode, payload: bytes, send_lock):
    with send_lock:
        header = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header += bytes([n])
        elif n < 65536:
            header += bytes([126]) + struct.pack('>H', n)
        else:
            header += bytes([127]) + struct.pack('>Q', n)
        wfile.write(header + payload)
        wfile.flush()


# ---------------------------------------------------------------- 桥接实现

def _bridge_ws_udp(rfile, wfile, host, port, send_lock, log):
    """WS ↔ UDP 数据报桥(每个 WS 连接一个 UDP socket)。"""
    infos = socket.getaddrinfo(host, port, 0, socket.SOCK_DGRAM)
    af, st, pr, _, sa = infos[0]
    udp = socket.socket(af, st, pr)
    try:
        udp.settimeout(0.05)
        stop = threading.Event()

        def pump_udp_to_ws():
            while not stop.is_set():
                try:
                    data, src = udp.recvfrom(65535)
                except socket.timeout:
                    continue
                except OSError:
                    break
                if not data:
                    continue
                try:
                    ws_send_frame(wfile, OP_BIN, data, send_lock)
                except Exception:
                    break
            stop.set()

        t = threading.Thread(target=pump_udp_to_ws, daemon=True)
        t.start()
        log(f'relay: UDP bridge → {host}:{port}')
        while not stop.is_set():
            try:
                op, payload = ws_read_message(rfile)
            except (ConnectionError, OSError, ValueError):
                break
            if op == OP_CLOSE:
                try:
                    ws_send_frame(wfile, OP_CLOSE, payload, send_lock)
                except Exception:
                    pass
                break
            if op == OP_PING:
                try:
                    ws_send_frame(wfile, OP_PONG, payload, send_lock)
                except Exception:
                    pass
                continue
            if op == OP_PONG:
                continue
            if op in (OP_BIN, OP_TEXT) and payload:
                try:
                    udp.sendto(payload, sa)
                except OSError as e:
                    if e.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH,
                                   errno.ECONNREFUSED, errno.EINVAL):
                        # 目标不可达: 静默丢弃(UDP 语义), 引擎有自己的重试
                        continue
                    break
        stop.set()
    finally:
        try:
            udp.close()
        except Exception:
            pass


def _bridge_ws_tcp(rfile, wfile, host, port, send_lock, log):
    """WS ↔ TCP 透传桥。"""
    infos = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
    af, st, pr, _, sa = infos[0]
    tcp = socket.socket(af, st, pr)
    tcp.settimeout(8)
    try:
        tcp.connect(sa)
    except OSError:
        try:
            tcp.close()
        except Exception:
            pass
        return
    tcp.settimeout(0.05)
    stop = threading.Event()

    def pump_tcp_to_ws():
        while not stop.is_set():
            try:
                data = tcp.recv(65535)
            except socket.timeout:
                continue
            except OSError:
                break
            if not data:
                break
            try:
                ws_send_frame(wfile, OP_BIN, data, send_lock)
            except Exception:
                break
        stop.set()

    t = threading.Thread(target=pump_tcp_to_ws, daemon=True)
    t.start()
    log(f'relay: TCP bridge → {host}:{port}')
    try:
        while not stop.is_set():
            try:
                op, payload = ws_read_message(rfile)
            except (ConnectionError, OSError, ValueError):
                break
            if op == OP_CLOSE:
                break
            if op == OP_PING:
                try:
                    ws_send_frame(wfile, OP_PONG, payload, send_lock)
                except Exception:
                    pass
                continue
            if op in (OP_BIN, OP_TEXT) and payload:
                try:
                    tcp.sendall(payload)
                except OSError:
                    break
    finally:
        stop.set()
        try:
            tcp.close()
        except Exception:
            pass


def handle_ws_upgrade(handler, log=None):
    """
    在 BaseHTTPRequestHandler 中升级 WebSocket 并执行中继桥接。
    返回 True 表示已处理(该连接被中继接管, 不得再走 HTTP 流程)。
    """
    log = log or (lambda msg: None)
    key = handler.headers.get('Sec-WebSocket-Key')
    if not key:
        return False
    parsed = parse_relay_path(handler.path.split('?')[0])
    # 握手响应(101)
    handler.connection.sendall(
        ('HTTP/1.1 101 Switching Protocols\r\n'
         'Upgrade: websocket\r\n'
         'Connection: Upgrade\r\n'
         f'Sec-WebSocket-Accept: {_accept_key(key)}\r\n'
         '\r\n').encode())
    handler.close_connection = True

    rfile, wfile = handler.rfile, handler.connection.makefile('wb', 0)
    send_lock = threading.Lock()

    def relay_log(msg):
        log(msg)

    try:
        if not parsed:
            try:
                ws_send_frame(wfile, OP_CLOSE, struct.pack('>H', 1008), send_lock)
            except Exception:
                pass
            return True
        mode, host, port = parsed
        if mode == 'u':
            _bridge_ws_udp(rfile, wfile, host, port, send_lock, relay_log)
        else:
            _bridge_ws_tcp(rfile, wfile, host, port, send_lock, relay_log)
    except (ConnectionError, BrokenPipeError, OSError):
        pass
    except Exception as e:  # noqa
        relay_log(f'relay: error {e!r}')
    finally:
        try:
            wfile.close()
        except Exception:
            pass
        try:
            handler.connection.close()
        except Exception:
            pass
    return True
