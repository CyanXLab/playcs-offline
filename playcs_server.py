#!/usr/bin/env python3
"""
PLAYCS.CC 离线版 一体化本地服务器
====================================
- 单端口 8787（默认）：静态文件 + 账号 API + 联机中继 全在一个端口
  * 兼容旧用法: python3 playcs_server.py [静态端口] [API端口]
  * play.js 内置 localhost 开发模式会自动连接 8787 端口
  * 大厅通过 localStorage 'lobby.auth.apiBase' 指向同端口（index.html 已注入引导脚本）
- 服务器列表 /api/servers：自动合并 playcs.cc 官方服务器（经官方中继）
  + 本地自定义条目（offline-servers.json）
- 内置 WebSocket 中继（ws_relay.py）：
    ws://<host>:<端口>/websocket/u/<目标IP>:<端口>   → UDP 桥
    ws://<host>:<端口>/websocket/t/<目标IP>:<端口>   → TCP 桥
  用于联机：引擎 socket → WS → 本中继 → 局域网/公网真实 CS:S 服务器。

账号：本地注册，无需邮箱验证码（邮箱缺省自动生成）。
账号数据保存在 playcs_data/accounts.json（密码为 PBKDF2 加盐哈希）。
局域网/自定义服务器列表保存在 offline-servers.json（可手动编辑）。

用法:
    python3 playcs_server.py            # 单端口 8787
    python3 playcs_server.py 8787       # 指定单端口
    python3 playcs_server.py 8000 8787  # 旧双端口模式
"""
import hashlib
import json
import os
import re
import secrets
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import ws_relay

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, 'playcs_data')
ACCOUNTS_FILE = os.path.join(DATA_DIR, 'accounts.json')
ACHIEVE_FILE = os.path.join(DATA_DIR, 'achievements_local.json')
SERVERS_FILE = os.path.join(ROOT, 'offline-servers.json')

# ---------------------------------------------------------------- 官方服务器列表(自动同步)
OFFICIAL_API = 'https://api.playcs.cc:9443/api/servers'
OFFICIAL_RELAY = 'wss://css.yikm.net/websocket/u'
_official_cache = {'at': 0.0, 'servers': []}
_official_fetching = [False]


def _fetch_official_servers_async():
    """后台线程同步官方服务器列表, 60s 缓存; 失败静默(离线可用)。"""
    import time as _t
    import urllib.request
    import threading
    if _t.time() - _official_cache['at'] < 60 and _official_cache['servers']:
        return
    if _official_fetching[0]:
        return
    _official_fetching[0] = True

    def _job():
        try:
            req = urllib.request.Request(OFFICIAL_API, headers={'Accept': 'application/json',
                                                                 'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=6) as r:
                d = json.loads(r.read().decode('utf-8'))
            if d.get('ok') and isinstance(d.get('servers'), list):
                _official_cache['at'] = _t.time()
                _official_cache['servers'] = d['servers']
                print('[servers] 官方列表同步成功: %d 台' % len(d['servers']))
        except Exception:
            pass  # 离线/官方不可达 → 保持本地列表
        finally:
            _official_fetching[0] = False

    threading.Thread(target=_job, daemon=True).start()


def _official_payload(s, i):
    return {
        'id': 'of-' + str(s.get('id') or i),
        'name': s.get('name') or ('官方服 %d' % i),
        'connect': s.get('connect') or '',
        'map': s.get('map') or '',
        'mode': s.get('mode') or 'classic',
        'wsProxyUrl': OFFICIAL_RELAY,
        'players': s.get('players') or 0,
        'maxPlayers': s.get('maxPlayers') or 32,
        'official': True,
    }

MIME = {
    '.wasm': 'application/wasm', '.data': 'application/octet-stream',
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
    '.html': 'text/html', '.txt': 'text/plain', '.woff': 'font/woff',
    '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.xml': 'application/xml',
    '.map': 'application/json', '.so': 'application/wasm',
}

# ---------------------------------------------------------------- 账号存储

_lock = threading.Lock()


def _load_accounts():
    try:
        with open(ACCOUNTS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {'accounts': {}, 'tokens': {}}


def _save_accounts(db):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(ACCOUNTS_FILE, 'w', encoding='utf-8') as f:
        json.dump(db, f, ensure_ascii=False, indent=2)


def _hash_pw(password, salt=None):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 120_000)
    return salt, h.hex()


def _default_avatar():
    # 1x1 透明 png 的 data URL，占位头像
    return None


def _public_user(acc):
    return {
        'id': acc['id'],
        'username': acc['username'],
        'displayName': acc['displayName'],
        'email': acc['email'],
        'avatarUrl': acc.get('avatarUrl'),
        'avatarUpdatedAt': acc.get('avatarUpdatedAt'),
    }


def _session_payload(acc):
    """与原站登录响应同构（app.js Nr() 读取的字段）"""
    return {
        'ok': True,
        'user': _public_user(acc),
        'accessToken': acc.get('accessToken') or _new_token(acc['email']),
        'profile': acc.get('profile') or {'profileLevel': 1, 'xpInLevel': 0, 'xpToNext': 500},
        'loadout': acc.get('loadout') or {},
        'rewardActivity': acc.get('rewardActivity') or [],
        'achievementsSummary': acc.get('achievementsSummary') or None,
        'pendingRewardNotices': [],
    }


def _new_token(email):
    with _lock:
        db = _load_accounts()
        tok = 'local-' + secrets.token_hex(24)
        db['tokens'][tok] = email
        for a in db['accounts'].values():
            if a['email'] == email:
                a['accessToken'] = tok
        _save_accounts(db)
        return tok


def _user_by_token(token):
    if not token:
        return None
    with _lock:
        db = _load_accounts()
        email = db['tokens'].get(token)
        return db['accounts'].get(email)


def _load_achievements_catalog():
    path = os.path.join(ROOT, 'data', 'achievements-i18n.json')
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {'groups': {}, 'entries': []}


def _now():
    return int(time.time() * 1000)


def _relay_log(msg):
    sys.stderr.write('[relay] %s\n' % msg)


def _load_servers_file():
    """offline-servers.json: {"servers": [{"id","name","connect","map","mode","wsProxyUrl"}]}"""
    try:
        with open(SERVERS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {'servers': []}


def _server_payload(srv, sid):
    return {
        'id': sid,
        'name': srv.get('name') or sid,
        'connect': srv.get('connect') or '',
        'map': srv.get('map') or '',
        'mode': srv.get('mode') or 'classic',
        'wsProxyUrl': srv.get('wsProxyUrl') or '',
        'players': srv.get('players', 0),
        'maxPlayers': srv.get('maxPlayers', 32),
        'official': bool(srv.get('official', False)),
    }


# ---------------------------------------------------------------- API Handler

class ApiHandler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'PlaycsLocalAPI/1.0'

    # ---- CORS（大厅页面 8000 端口 → API 8787 跨域） ----
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept')
        self.send_header('Access-Control-Max-Age', '86400')

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self._cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _bearer(self):
        auth = self.headers.get('Authorization') or ''
        return auth[7:].strip() if auth.startswith('Bearer ') else None

    def _body(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
            return json.loads(self.rfile.read(n) or b'{}')
        except Exception:
            return {}

    def log_message(self, fmt, *args):
        pass  # API 日志静默，避免刷屏

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        # WS 中继升级请求（API 端口也支持联机网关）
        p = self.path.split('?')[0]
        if p.startswith('/websocket/'):
            try:
                ws_relay.handle_ws_upgrade(self, _relay_log)
            except Exception:
                pass
            return
        self._route('GET')

    def do_POST(self):
        self._route('POST')

    def _route(self, method):
        path = self.path.split('?')[0].rstrip('/') or '/'
        try:
            handler = self._match(method, path)
            if handler:
                handler()
            else:
                # 兜底：未识别的接口一律返回 ok，保证大厅功能不报错
                self._json({'ok': True})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa
            try:
                self._json({'ok': False, 'errorKey': 'server.error', 'detail': str(e)}, 500)
            except Exception:
                pass

    def _match(self, method, path):
        H = lambda: self._json  # noqa

        # ---------- 基础 ----------
        if path == '/api/auth/config':
            def h():
                self._json({'ok': True, 'registration': {'enabled': True},
                            'turnstile': {'enabled': False},
                            'announcement': None, 'xpEvent': None})
            return h

        if path == '/api/auth/send-code' and method == 'POST':
            def h():
                b = self._body()
                # 本地版无邮箱验证: 直接把验证码返回给页面, 任意码均可注册
                self._json({'ok': True, 'messageKey': 'auth.sendCodeSuccess',
                            'cooldownSeconds': 1, 'code': '888888',
                            'devCode': '888888',
                            'note': 'offline: any code accepted'})
            return h

        if path == '/api/auth/register' and method == 'POST':
            return self._register

        if path == '/api/auth/login' and method == 'POST':
            return self._login

        if path == '/api/auth/forgot-password' and method == 'POST':
            def h():
                b = self._body()
                email = (b.get('email') or '').strip().lower()
                with _lock:
                    db = _load_accounts()
                    reset_token = ''
                    acc = db['accounts'].get(email)
                    if acc:
                        reset_token = 'reset-' + secrets.token_hex(16)
                        acc['resetToken'] = reset_token
                        _save_accounts(db)
                self._json({'ok': True, 'messageKey': 'auth.forgotSuccess',
                            'resetToken': reset_token})
            return h

        if path == '/api/auth/reset-password' and method == 'POST':
            def h():
                b = self._body()
                token = (b.get('token') or b.get('resetToken') or '').strip()
                pw = b.get('password') or ''
                with _lock:
                    db = _load_accounts()
                    acc = next((a for a in db['accounts'].values()
                                if a.get('resetToken') == token and token), None)
                    if not acc:
                        return self._json({'ok': False,
                                           'errorKey': 'auth.error.resetTokenInvalid'}, 400)
                    salt, hsh = _hash_pw(pw)
                    acc['salt'], acc['passwordHash'] = salt, hsh
                    acc['resetToken'] = None
                    _save_accounts(db)
                self._json({'ok': True, 'email': acc['email']})
            return h

        if path == '/api/auth/fix-nickname' and method == 'POST':
            def h():
                b = self._body()
                email = (b.get('email') or '').strip().lower()
                pw = b.get('password') or ''
                dn = (b.get('displayName') or '').strip()
                with _lock:
                    db = _load_accounts()
                    acc = db['accounts'].get(email)
                    if not acc:
                        return self._json({'ok': False,
                                           'errorKey': 'auth.error.invalidCredentials'}, 401)
                    _, hsh = _hash_pw(pw, acc['salt'])
                    if hsh != acc['passwordHash']:
                        return self._json({'ok': False,
                                           'errorKey': 'auth.error.invalidCredentials'}, 401)
                    acc['displayName'] = dn or acc['displayName']
                    _save_accounts(db)
                self._json(_session_payload(acc))
            return h

        if path == '/api/auth/me':
            def h():
                acc = _user_by_token(self._bearer())
                if not acc:
                    self._json({'ok': False, 'errorKey': 'auth.error.notLoggedIn'}, 401)
                    return
                p = _session_payload(acc)
                p.update({'profile': acc.get('profile') or p['profile'],
                          'loadout': acc.get('loadout') or {},
                          'rewardActivity': acc.get('rewardActivity') or [],
                          'achievementsSummary': acc.get('achievementsSummary') or None})
                self._json(p)
            return h

        # ---------- 服务器列表（官方列表自动同步 + offline-servers.json + URL 参数覆盖） ----------
        if path == '/api/servers':
            def h():
                conf = _load_servers_file()
                _fetch_official_servers_async()
                from urllib.parse import urlparse, parse_qs, unquote
                q = parse_qs(urlparse(self.path).query)
                # 支持 ?connect=1.2.3.4:27015&map=de_dust2&ws=ws://... 动态注册
                if q.get('connect'):
                    dyn = _server_payload({
                        'name': (q.get('name') or ['快速连接'])[0],
                        'connect': unquote(q['connect'][0]),
                        'map': (q.get('map') or [''])[0],
                        'wsProxyUrl': (q.get('ws') or [''])[0],
                    }, 'dynamic')
                    self._json({'ok': True, 'servers': [dyn]})
                    return
                official = [_official_payload(s, i)
                            for i, s in enumerate(_official_cache['servers'])]
                local = [_server_payload(s, s.get('id') or ('lan-%d' % i))
                         for i, s in enumerate(conf.get('servers', []))]
                self._json({'ok': True, 'servers': official + local})
            return h
        if path.startswith('/api/servers/'):
            def h():
                from urllib.parse import urlparse, parse_qs, unquote
                sid = unquote(path[len('/api/servers/'):])
                srv = None
                if sid.startswith('of-'):
                    oid = sid[3:]
                    raw = next((s for s in _official_cache['servers']
                                if str(s.get('id') or '') == oid), None)
                    if raw:
                        srv = _official_payload(raw, oid)
                else:
                    conf = _load_servers_file()
                    srv = next((s for s in conf.get('servers', [])
                                if (s.get('id') or '') == sid), None)
                    if srv:
                        srv = _server_payload(srv, sid)
                q = parse_qs(urlparse(self.path).query)
                if srv is None and q.get('connect'):
                    srv = {'name': (q.get('name') or [sid])[0],
                           'connect': unquote(q['connect'][0]),
                           'map': (q.get('map') or [''])[0],
                           'wsProxyUrl': (q.get('ws') or [''])[0]}
                if srv is None:
                    self._json({'ok': False, 'errorKey': 'servers.notFound'}, 404)
                    return
                self._json({'ok': True, 'server': srv})
            return h

        # ---------- 商店 / 开箱 / 炼金（离线无数据，优雅降级） ----------
        if path == '/api/shop/products':
            def h():
                self._json({'ok': True, 'products': []})
            return h
        if path == '/api/shop/redeem':
            def h():
                self._json({'ok': False, 'errorKey': 'shop.error.redeemFailed'}, 400)
            return h
        if path == '/api/cases/open' or path.startswith('/api/cases/'):
            def h():
                self._json({'ok': False, 'errorKey': 'inventory.error.offline'}, 400)
            return h
        if path in ('/api/alchemy/config', '/api/alchemy/preview', '/api/alchemy/craft'):
            def h():
                self._json({'ok': False, 'errorKey': 'inventory.error.offline'}, 400)
            return h

        # ---------- 库存 / 改名（本地账号可用） ----------
        if path == '/api/inventory/skins' or path == '/api/inventory/loadout':
            def h():
                acc = _user_by_token(self._bearer())
                if not acc:
                    return self._json({'ok': False, 'errorKey': 'auth.error.notLoggedIn'}, 401)
                self._json({'ok': True, 'inventory': acc.get('inventory') or [],
                            'loadout': acc.get('loadout') or {}, 'loadoutUserinfo': ''})
            return h
        if path == '/api/inventory/rewards':
            def h():
                self._json({'ok': True, 'rewards': []})
            return h
        if path == '/api/inventory/rename' and method == 'POST':
            def h():
                acc = _user_by_token(self._bearer())
                if not acc:
                    return self._json({'ok': False, 'errorKey': 'auth.error.notLoggedIn'}, 401)
                b = self._body()
                dn = (b.get('displayName') or '').strip()
                if not dn:
                    return self._json({'ok': False,
                                       'errorKey': 'inventory.error.renameFailed'}, 400)
                inv = acc.setdefault('inventory', [])
                item = next((i for i in inv
                             if i.get('instanceId') == b.get('toolInstanceId')), None)
                if item is not None:
                    item['displayName'] = dn
                    with _lock:
                        db = _load_accounts()
                        db['accounts'][acc['email']]['inventory'] = inv
                        _save_accounts(db)
                self._json({'ok': True, 'displayName': dn,
                            'user': _public_user(acc), 'tools': inv})
            return h

        # ---------- 成就 ----------
        if path == '/api/achievements/catalog':
            def h():
                cat = _load_achievements_catalog()
                self._json({'ok': True, 'groups': cat.get('groups', {}),
                            'entries': cat.get('entries', {})})
            return h
        if path == '/api/achievements/me':
            def h():
                try:
                    with open(ACHIEVE_FILE, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                except Exception:
                    data = {'unlocked': [], 'summary': {}}
                self._json({'ok': True, 'unlocked': data.get('unlocked', []),
                            'summary': data.get('summary', {})})
            return h
        if path == '/api/achievements/sync':
            def h():
                b = self._body()
                try:
                    os.makedirs(DATA_DIR, exist_ok=True)
                    with open(ACHIEVE_FILE, 'w', encoding='utf-8') as f:
                        json.dump(b, f, ensure_ascii=False)
                except Exception:
                    pass
                self._json({'ok': True, 'unlocked': b.get('unlocked', []),
                            'summary': b.get('summary', {})})
            return h

        # ---------- 游戏资源配置（皮肤包 / 资源版本号） ----------
        if path == '/api/game/skin-chunks':
            def h():
                chunks = []
                for name in ('weapon_skins', 'savior', 'zemod', 'hideandseek', 'hud'):
                    if os.path.exists(os.path.join(ROOT, 'chunks', name + '.data')):
                        chunks.append({'url': 'chunks/' + name + '.data'})
                self._json({'ok': True, 'chunks': chunks})
            return h
        if path == '/api/game/asset-versions':
            def h():
                self._json({'ok': True, 'defaultVersion': '', 'versions': {}})
            return h

        # ---------- 战绩 / 排行榜（本地空数据） ----------
        if path.startswith('/api/stats/lifetime/'):
            def h():
                self._json({'ok': True, 'lifetime': {}})
            return h
        if path.startswith('/api/stats/leaderboard/me'):
            def h():
                self._json({'ok': True, 'rank': None, 'entry': None})
            return h
        if path.startswith('/api/stats/leaderboard'):
            def h():
                self._json({'ok': True, 'entries': [], 'total': 0,
                            'page': 1, 'pages': 1})
            return h
        if path == '/api/stats/me':
            def h():
                self._json({'ok': True, 'stats': {}})
            return h

        # ---------- 头像 ----------
        if path == '/api/profile/avatar' and method == 'GET':
            def h():
                acc = _user_by_token(self._bearer())
                if not acc:
                    return self._json({'ok': True, 'avatarUrl': None})
                self._json({'ok': True, 'avatarUrl': acc.get('avatarUrl')})
            return h
        if path == '/api/profile/avatar' and method == 'POST':
            def h():
                acc = _user_by_token(self._bearer())
                if not acc:
                    return self._json({'ok': False, 'errorKey': 'auth.error.notLoggedIn'}, 401)
                raw = self.rfile.read(int(self.headers.get('Content-Length') or 0))
                # 接受任意上传，本地存 base64（限制 512KB）
                if len(raw) > 512 * 1024:
                    return self._json({'ok': False, 'errorKey': 'profile.avatarTooLarge'}, 400)
                url = 'data:image/png;base64,' + \
                    __import__('base64').b64encode(raw).decode() if raw else None
                with _lock:
                    db = _load_accounts()
                    db['accounts'][acc['email']]['avatarUrl'] = url
                    db['accounts'][acc['email']]['avatarUpdatedAt'] = _now()
                    _save_accounts(db)
                self._json({'ok': True, 'avatarUrl': url})
            return h

        # ---------- 活动流 ----------
        if path == '/api/reward/activity' or path == '/api/activity':
            def h():
                self._json({'ok': True, 'activity': []})
            return h
        return None

    # ---- 注册 / 登录（本地版: 邮箱可选自动生成, 无需验证码, 收到即注册） ----
    def _register(self):
        b = self._body()
        email = (b.get('email') or '').strip().lower()
        display = (b.get('displayName') or '').strip()
        pw = b.get('password') or ''
        if email and not re.match(r'^[^@\s]+@[^@\s]+\.[^@\s]+$', email):
            return self._json({'ok': False, 'errorKey': 'auth.error.emailInvalid'}, 400)
        if not email:
            email = 'player-' + secrets.token_hex(4) + '@local.players'
        if not display:
            return self._json({'ok': False, 'errorKey': 'auth.error.nicknameInvalid'}, 400)
        if len(pw) < 6:
            return self._json({'ok': False, 'errorKey': 'auth.error.passwordShort'}, 400)
        with _lock:
            db = _load_accounts()
            if email in db['accounts']:
                return self._json({'ok': False, 'errorKey': 'auth.error.emailExists'}, 400)
            if any(a['displayName'].lower() == display.lower()
                   for a in db['accounts'].values()):
                return self._json({'ok': False,
                                   'errorKey': 'auth.error.nicknameTaken'}, 400)
            salt, hsh = _hash_pw(pw)
            acc = {
                'id': 1 + max([a.get('id', 0) for a in db['accounts'].values()] or [0]),
                'email': email, 'username': display, 'displayName': display,
                'salt': salt, 'passwordHash': hsh,
                'createdAt': _now(), 'profileLevel': 1,
                'profile': {'profileLevel': 1, 'xpInLevel': 0, 'xpToNext': 500},
                'inventory': [], 'loadout': {}, 'rewardActivity': [],
            }
            db['accounts'][email] = acc
            _save_accounts(db)
        self._json(_session_payload(acc))

    def _login(self):
        b = self._body()
        email = (b.get('email') or '').strip().lower()
        pw = b.get('password') or ''
        with _lock:
            db = _load_accounts()
            acc = db['accounts'].get(email)
            if not acc:
                return self._json({'ok': False,
                                   'errorKey': 'auth.error.invalidCredentials'}, 401)
            _, hsh = _hash_pw(pw, acc['salt'])
            if hsh != acc['passwordHash']:
                return self._json({'ok': False,
                                   'errorKey': 'auth.error.invalidCredentials'}, 401)
        self._json(_session_payload(acc))


# ---------------------------------------------------------------- 静态 Handler
# 继承 ApiHandler：单端口同时提供 静态文件 + API stub + WS 中继。
# 页面无论从哪个端口打开，origin 即可提供全部服务（浏览器版与 Electron 版同构）。

class StaticHandler(ApiHandler):
    protocol_version = 'HTTP/1.1'

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return MIME.get(ext) or super().guess_type(path)

    def do_GET(self):
        p = self.path.split('?')[0]
        if p.startswith('/websocket/'):
            try:
                ws_relay.handle_ws_upgrade(self, _relay_log)
            except Exception:
                pass
            return
        if p.startswith('/api/'):
            self._route('GET')
            return
        try:
            SimpleHTTPRequestHandler.do_GET(self)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_HEAD(self):
        try:
            SimpleHTTPRequestHandler.do_HEAD(self)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, fmt, *args):
        # 大文件下载时靜态日志过多，仅输出非 200
        try:
            code = args[1] if len(args) > 1 else '?'
            if str(code) not in ('200', '206', '304'):
                sys.stderr.write('[static] %s\n' % (fmt % args))
        except Exception:
            pass


# ---------------------------------------------------------------- main

def main():
    # 单端口模式(默认 8787): 静态+API+中继 同端口; 兼容旧双端口用法
    static_port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    api_port = int(sys.argv[2]) if len(sys.argv) > 2 else static_port

    os.chdir(ROOT)
    static_srv = ThreadingHTTPServer(('0.0.0.0', static_port), StaticHandler)
    static_srv.daemon_threads = True

    api_srv = None
    if api_port != static_port:
        api_srv = ThreadingHTTPServer(('0.0.0.0', api_port), ApiHandler)
        api_srv.daemon_threads = True
        threading.Thread(target=api_srv.serve_forever, daemon=True).start()

    _fetch_official_servers_async()  # 后台预热官方服务器列表

    print('PLAYCS.CC 离线版已启动')
    print(f'  游戏大厅:  http://localhost:{static_port}/')
    print(f'  单端口说明: {static_port} 端口同时提供 静态页面 + API + 联机中继')
    if api_srv is not None:
        print(f'  本地API :  http://localhost:{api_port}/  (独立 API 端口, 兼容旧配置)')
    print(f'  联机中继:  ws://localhost:{static_port}/websocket/u/<服务器IP>:<端口>  (UDP 桥)')
    print(f'  局域网  :  用 http://<本机IP>:{static_port}/ 从其他设备访问')
    print('按 Ctrl+C 停止')
    try:
        static_srv.serve_forever()
    except KeyboardInterrupt:
        print('\n服务器已停止')


if __name__ == '__main__':
    main()
