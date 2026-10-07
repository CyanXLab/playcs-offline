/*
 * PLAYCS 离线增强补丁 (offline-enhance.js)
 * ============================================================
 * 必须在 play.js 之后加载(依赖其中的全局 API)。
 *
 * 功能:
 *   1. 修复游戏内换图资源不加载(紫黑方块/机器人不加入/自动重进)bug
 *      —— 原因: 引擎运行时缺地图文件时调用 Module.downloadMap(),
 *         play.js 在纯 Web 模式下直接解锁而不加载任何资源。
 *      —— 修复: 覆盖 Module.downloadMap, 通过官方公开 API
 *         window.loadGameDataChunk() 拉取 chunks/<地图>.data 并解包挂载,
 *         完成后再解锁引擎(Atomics.store + notify)。
 *   2. 离线改名: 玩家昵称即引擎 convar `name`,
 *      通过 window.engineRunCommand() 即时生效, 无需在线账号 API。
 *   3. 中继(联机网关)设置: 引擎 C++ 侧读取 Module.wsProxyUrl,
 *      connect 时拼成 <基址>/<目标addr>:<目标port> 并建立 WebSocket。
 *      支持三种: 官方网关 / 本地默认中继 / 自定义地址。
 *   4. 快速连接服务器列表: localStorage 持久化, 一键跳转
 *      play.html?connect=<addr>&ws=<relay>&map=<map>
 *   5. 设置面板 UI(F8 呼出 / 右下角齿轮), 大厅与游戏内通用。
 *   6. 本地账号: 一键创建(昵称+密码, 无需邮箱验证码), 自动写入
 *      lobby.auth.session.v1 并刷新大厅; 官方注册表单自动填充辅助。
 *   7. 中继连通性测试 + 当前渲染 GPU 检测(独显/核显提示)。
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.__OFFLINE_ENHANCE__) return;
  window.__OFFLINE_ENHANCE__ = true;

  // ------------------------------------------------------------
  // 常量与存储键
  // ------------------------------------------------------------
  var LS = {
    name: 'offline.playerName',
    relay: 'offline.relayUrl',        // 'official' | 'local' | 自定义URL
    servers: 'offline.servers',       // JSON 数组 [{name, addr, map}]
    panelSeen: 'offline.panelSeen',
    accountOffer: 'offline.accountOfferDismissed'
  };
  var SESSION_KEY = 'lobby.auth.session.v1';
  // 官方网关基址(playcs.cc 使用的作者网关, 见 libengine.so 内嵌 EM_JS)
  var RELAY_OFFICIAL = 'wss://css.yikm.net/websocket/u';
  // 本地默认中继: 与本地服务器同源同端口(playcs_server.py 内置 WS 中继)
  function localRelayUrl() {
    var h = location.hostname || '127.0.0.1';
    if (location.protocol === 'file:') return 'ws://127.0.0.1:8787/websocket/u';
    var port = location.port || (location.protocol === 'https:' ? '443' : '80');
    return location.protocol.replace('http', 'ws') + '//' + h + ':' + port + '/websocket/u';
  }

  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  // ------------------------------------------------------------
  // 1. 换图修复 —— 覆盖 Module.downloadMap
  // ------------------------------------------------------------
  function patchDownloadMap() {
    if (!window.Module) return false;
    if (window.__OFFLINE_DLMAP_PATCHED__) return true;
    Module.downloadMap = function (lock, mapName) {
      var finish = function () {
        try {
          var heap = (typeof HEAP32 !== 'undefined') ? HEAP32 : Module.HEAP32;
          if (heap) { Atomics.store(heap, lock, 0); Atomics.notify(heap, lock); }
        } catch (e) { /* 引擎侧轮询兜底 */ }
      };
      try {
        var raw = String(mapName || '');
        // 兼容 "de_dust2" / "maps/de_dust2.bsp" / "/cstrike/maps/de_dust2.bsp"
        var base = raw.replace(/\\/g, '/').split('/').pop().replace(/\.bsp$/i, '').toLowerCase().trim();
        if (!base || !/^[a-z0-9_\-]+$/.test(base)) { finish(); return; }
        var url = 'chunks/' + base + '.data';
        window.__OFFLINE_LOADED_CHUNKS__ = window.__OFFLINE_LOADED_CHUNKS__ || {};
        if (window.__OFFLINE_LOADED_CHUNKS__[url]) { finish(); return; }
        window.__OFFLINE_LOADED_CHUNKS__[url] = true; // 防重入
        console.log('[offline] downloadMap → loading', url);
        var p;
        if (typeof window.loadGameDataChunk === 'function') {
          // 官方公开 API: 带加载 UI 进度
          p = window.loadGameDataChunk(url, base, true);
        } else {
          p = fetch(url)
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
            .then(function (buf) {
              if (typeof window.applyPackedGameDataToFS === 'function') return window.applyPackedGameDataToFS(buf);
            });
        }
        p.then(function () {
          console.log('[offline] map chunk ready:', url);
          finish();
        }).catch(function (e) {
          console.warn('[offline] map chunk FAILED:', url, e);
          window.__OFFLINE_LOADED_CHUNKS__[url] = false;
          finish(); // 解锁让引擎继续(即使失败, 行为与原版一致)
        });
      } catch (e) { finish(); }
    };
    window.__OFFLINE_DLMAP_PATCHED__ = true;
    console.log('[offline] Module.downloadMap patched (in-game map switching fixed)');
    return true;
  }

  // ------------------------------------------------------------
  // 2. 玩家昵称(离线改名)
  // ------------------------------------------------------------
  function syncNameToLobbySession(name) {
    try {
      var raw = localStorage.getItem('lobby.auth.session.v1');
      var sess = {};
      if (raw) { try { sess = JSON.parse(raw) || {}; } catch (e) { sess = {}; } }
      sess.displayName = name;
      sess.username = name;
      if (!sess.accessToken) sess.accessToken = 'offline-local';
      localStorage.setItem('lobby.auth.session.v1', JSON.stringify(sess));
    } catch (e) {}
  }
  function getPlayerName() { return String(lsGet(LS.name, '') || '').trim(); }
  function setPlayerName(name, live) {
    name = String(name || '').replace(/["\\\n\r]/g, '').trim().slice(0, 32);
    if (!name) return false;
    lsSet(LS.name, name);
    syncNameToLobbySession(name);
    if (live !== false && typeof window.engineRunCommand === 'function') {
      try { window.engineRunCommand('name "' + name + '"'); return true; } catch (e) {}
    }
    return false;
  }
  function applyNameOnBoot() {
    var n = getPlayerName();
    if (n) syncNameToLobbySession(n);
  }

  // ------------------------------------------------------------
  // 3. 中继(联机网关)设置
  // ------------------------------------------------------------
  function getRelayMode() {
    var v = lsGet(LS.relay, 'local');
    return v || 'local';
  }
  function getRelayUrl() {
    var m = getRelayMode();
    if (m === 'official') return RELAY_OFFICIAL;
    if (m === 'local') return localRelayUrl();
    return m; // 自定义完整基址
  }
  function setRelay(mode) {
    lsSet(LS.relay, mode);
    applyRelayUrl(true);
  }
  function applyRelayUrl(fromUser) {
    var u = getRelayUrl();
    try { Module.wsProxyUrl = u; } catch (e) {}
    try { window.__SOURCE_WS_PROXY_URL__ = u; } catch (e) {}
    try { globalThis.__SOURCE_WS_PROXY_URL__ = u; } catch (e) {}
    // 不写 localStorage.source_ws_proxy_url: practice 模式下 play.js 不读它,
    // 我们直接控制 Module.wsProxyUrl(引擎 connect 时实时读取)。
    if (fromUser) console.log('[offline] relay set →', u);
  }

  // ------------------------------------------------------------
  // 4. 快速连接服务器列表
  // ------------------------------------------------------------
  function getServers() {
    try {
      var v = JSON.parse(lsGet(LS.servers, '[]'));
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  function saveServers(list) { lsSet(LS.servers, JSON.stringify(list)); }
  function addServer(name, addr, map) {
    var list = getServers();
    list.push({ name: String(name || '').slice(0, 40), addr: String(addr || '').trim(), map: String(map || '').trim() });
    saveServers(list);
  }
  function removeServer(idx) {
    var list = getServers();
    list.splice(idx, 1);
    saveServers(list);
  }
  function joinServer(s) {
    var relay = encodeURIComponent(s.wsProxyUrl || getRelayUrl());
    var q = 'connect=' + encodeURIComponent(s.addr);
    if (s.map) q += '&map=' + encodeURIComponent(s.map);
    q += '&ws=' + relay;
    var base = location.pathname.replace(/[^/]*$/, '');
    location.href = location.origin + base + 'play.html?' + q;
  }

  // ------------------------------------------------------------
  // 6. 本地账号(无需邮箱验证码)
  // ------------------------------------------------------------
  function getSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      var s = raw ? JSON.parse(raw) : null;
      return (s && s.accessToken) ? s : null;
    } catch (e) { return null; }
  }
  // 复刻大厅 app.js 的 Nr(session 映射), 保证刷新后大厅直接识别
  function mapSession(d) {
    var t = d.profile || { profileLevel: 1, xpInLevel: 0, xpToNext: 500 };
    var lo = (d.loadout && typeof d.loadout === 'object') ? d.loadout : {};
    var lu = '';
    try {
      lu = Object.keys(lo).filter(function (k) { return Number(lo[k]) > 0; })
        .map(function (k) { return k + ':' + lo[k]; }).join(',');
    } catch (e) {}
    return {
      userId: d.user.id, username: d.user.username,
      displayName: d.user.displayName || d.user.username,
      email: d.user.email || null,
      avatarUrl: d.user.avatarUrl || null,
      avatarUpdatedAt: d.user.avatarUpdatedAt == null ? null : d.user.avatarUpdatedAt,
      accessToken: d.accessToken, loginAt: Date.now(),
      profileLevel: t.profileLevel == null ? 1 : t.profileLevel,
      profile: t, loadout: lo, loadoutUserinfo: lu,
      achievementsSummary: d.achievementsSummary == null ? null : d.achievementsSummary,
      achievementsRecent: [], achievementsUnlocked: [],
      rewardActivity: d.rewardActivity || []
    };
  }
  function localCreateAccount(display, password) {
    display = String(display || '').trim();
    password = String(password || '');
    if (!display) return Promise.reject('auth.error.nicknameInvalid');
    if (password.length < 6) return Promise.reject('auth.error.passwordShort');
    return fetch('/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: display, password: password })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) throw (d && d.errorKey) || 'auth.error.registerFailed';
      var sess = mapSession(d);
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(sess)); } catch (e) {}
      try { lsSet(LS.name, display); } catch (e) {}
      return sess;
    });
  }
  function localLogout() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    location.reload();
  }
  var ERR_TEXT = {
    'auth.error.nicknameInvalid': '昵称无效(2-32字符)',
    'auth.error.nicknameTaken': '昵称已被使用, 换一个试试',
    'auth.error.passwordShort': '密码至少 6 位',
    'auth.error.emailExists': '账号已存在, 直接登录即可',
    'auth.error.emailInvalid': '邮箱格式不正确',
    'network': '网络错误, 请确认本地服务已启动'
  };
  function errText(k) { return ERR_TEXT[k] || ('注册失败: ' + k); }

  function bindQuickCreate(form, nameInput, passInput, tipFn) {
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var btn = form.querySelector('button[type=submit]') || form.querySelector('button');
      if (btn) btn.disabled = true;
      tipFn('');
      localCreateAccount(nameInput.value, passInput.value)
        .then(function (sess) { tipFn('✓ 账号已创建: ' + sess.displayName + '，正在进入…'); setTimeout(function () { location.reload(); }, 600); })
        .catch(function (k) { tipFn(errText(k), true); if (btn) btn.disabled = false; });
    });
  }
  function randomPassword() {
    return 'pc' + Math.random().toString(36).slice(2, 8) + (Date.now() % 100);
  }
  function randomNick() {
    return '玩家' + Math.floor(1000 + Math.random() * 9000);
  }

  // 大厅自动弹出的本地账号引导(未登录时一次性)
  function offerAccountOverlay() {
    if (getSession() || lsGet(LS.accountOffer, '') === '1') return;
    if (!/\/(index\.html)?$/.test(location.pathname)) return; // 仅大厅页
    if (document.getElementById('ocs-account-offer')) return;
    var wrap = document.createElement('div');
    wrap.id = 'ocs-account-offer';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(5,8,14,.72);'
      + 'display:flex;align-items:center;justify-content:center;font:14px/1.6 system-ui,Segoe UI,Microsoft YaHei,sans-serif';
    wrap.innerHTML = ''
      + '<div style="width:360px;max-width:92vw;background:#101319;border:1px solid #2c3546;border-radius:12px;padding:22px 24px;color:#dfe3ea;box-shadow:0 12px 48px rgba(0,0,0,.6)">'
      + '<div style="font-size:17px;font-weight:600;color:#ffb84d;margin-bottom:6px">创建本地账号</div>'
      + '<div style="color:#8fa3bf;font-size:12.5px;margin-bottom:14px">离线版无需邮箱、无需验证码 —— 昵称 + 密码即点即玩。</div>'
      + '<form id="ocs-offer-form">'
      + '<input id="ocs-offer-nick" placeholder="游戏昵称" maxlength="32" style="width:100%;box-sizing:border-box;background:#0b0e14;border:1px solid #2c3546;border-radius:6px;color:#e6e9ef;padding:8px 10px;margin-bottom:8px">'
      + '<input id="ocs-offer-pass" placeholder="密码(至少 6 位, 可以后改)" style="width:100%;box-sizing:border-box;background:#0b0e14;border:1px solid #2c3546;border-radius:6px;color:#e6e9ef;padding:8px 10px">'
      + '<div id="ocs-offer-tip" style="color:#ff7b7b;font-size:12px;min-height:18px;margin-top:6px"></div>'
      + '<div style="display:flex;gap:8px;margin-top:6px;align-items:center">'
      + '<button type="submit" style="flex:1;background:#2d6cdf;border:none;border-radius:6px;color:#fff;padding:8px 0;font-size:14px;cursor:pointer">创建并进入</button>'
      + '<button type="button" id="ocs-offer-skip" style="background:#2a3140;border:none;border-radius:6px;color:#aab6c8;padding:8px 14px;font-size:13px;cursor:pointer">跳过</button>'
      + '</div></form>'
      + '<label style="display:flex;gap:6px;align-items:center;color:#7d8aa0;font-size:12px;margin-top:12px;cursor:pointer">'
      + '<input type="checkbox" id="ocs-offer-never"> 不再提示(可随时在 F8 设置面板创建)</label>'
      + '</div>';
    document.body.appendChild(wrap);
    var nick = wrap.querySelector('#ocs-offer-nick');
    var pass = wrap.querySelector('#ocs-offer-pass');
    nick.value = getPlayerName() || randomNick();
    pass.value = randomPassword();
    var tip = wrap.querySelector('#ocs-offer-tip');
    bindQuickCreate(wrap.querySelector('#ocs-offer-form'), nick, pass, function (msg, isErr) {
      tip.textContent = msg || '';
      tip.style.color = isErr ? '#ff7b7b' : '#6fd66f';
    });
    wrap.querySelector('#ocs-offer-skip').addEventListener('click', function () {
      if (wrap.querySelector('#ocs-offer-never').checked) lsSet(LS.accountOffer, '1');
      wrap.remove();
    });
  }

  // 官方注册表单辅助: 自动填充验证码/邮箱, 隐藏验证码行与发送按钮
  function assistRegisterForm() {
    var code = document.getElementById('reg-code');
    if (code && !code.dataset.ocsDone) {
      code.dataset.ocsDone = '1';
      code.value = '888888';
      try { code.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
      var row = code.closest('div');
      if (row && row.parentElement && row.querySelector('input') === code) row.style.display = 'none';
    }
    var turn = document.getElementById('turnstile-send-code');
    if (turn) turn.hidden = true;
    var panel = document.getElementById('auth-panel-register');
    if (panel && !panel.dataset.ocsBtnDone) {
      panel.dataset.ocsBtnDone = '1';
      panel.querySelectorAll('button').forEach(function (b) {
        if (/发送|send|resend/i.test((b.textContent || '').trim())) b.style.display = 'none';
      });
      var em = panel.querySelector('#reg-email');
      if (em && !em.value) {
        em.value = 'player' + Math.floor(1000 + Math.random() * 9000) + '@local.playcs';
        try { em.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
      }
    }
  }
  function startRegisterAssist() {
    var mo = new MutationObserver(function () { assistRegisterForm(); });
    try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    var n = 0;
    var t = setInterval(function () { assistRegisterForm(); if (++n > 120) clearInterval(t); }, 1000);
  }

  // ------------------------------------------------------------
  // 7. 中继连通性测试 + GPU 检测
  // ------------------------------------------------------------
  function testRelay(url) {
    return new Promise(function (resolve) {
      var done = false;
      var t0 = Date.now();
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve({ ok: false, ms: 0, err: '超时(6s)' }); }
      }, 6000);
      try {
        var ws = new WebSocket(url.replace(/\/$/, '') + '/1.2.3.4:27015');
        ws.onopen = function () {
          if (!done) { done = true; clearTimeout(timer); resolve({ ok: true, ms: Date.now() - t0 }); try { ws.close(); } catch (e) {} }
        };
        ws.onerror = function () {
          if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, ms: 0, err: '连接被拒' }); }
        };
        ws.onclose = function () {
          if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, ms: 0, err: '连接被拒' }); }
        };
      } catch (e) {
        if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, ms: 0, err: String(e) }); }
      }
    });
  }
  function detectGPU() {
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return { name: '(WebGL 不可用)', igpu: true };
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      var name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
                     : String(gl.getParameter(gl.RENDERER));
      var isIGPU = /intel|radeon\(tm\)|uhd|iris|hd graphics|apple gpu|swiftshader|llvmpipe/i.test(name)
                   && !/nvidia|geforce|rtx|gtx|arc a|radeon rx/i.test(name);
      return { name: name, igpu: isIGPU };
    } catch (e) { return { name: '(检测失败)', igpu: true }; }
  }

  // 对外 API(控制台/其他脚本可用)
  window.OfflineCS = {
    setName: setPlayerName,
    getName: getPlayerName,
    setRelay: setRelay,
    getRelay: getRelayUrl,
    getRelayMode: getRelayMode,
    servers: getServers,
    addServer: addServer,
    removeServer: removeServer,
    joinServer: joinServer,
    createAccount: localCreateAccount,
    logout: localLogout,
    getSession: getSession,
    testRelay: testRelay,
    detectGPU: detectGPU,
    RELAY_OFFICIAL: RELAY_OFFICIAL,
    version: '1.1.0'
  };

  // ------------------------------------------------------------
  // 5. 设置面板 UI
  // ------------------------------------------------------------
  var CSS = ''
    + '#ocs-gear{position:fixed;right:14px;bottom:14px;z-index:2147483000;width:40px;height:40px;'
    + 'border-radius:50%;background:rgba(20,24,32,.72);border:1px solid rgba(255,255,255,.18);'
    + 'color:#e8e8e8;font-size:20px;line-height:38px;text-align:center;cursor:pointer;'
    + 'user-select:none;opacity:.45;transition:opacity .2s;backdrop-filter:blur(4px)}'
    + '#ocs-gear:hover{opacity:1}'
    + '#ocs-panel{position:fixed;right:14px;bottom:62px;z-index:2147483000;width:340px;max-height:76vh;overflow:auto;'
    + 'background:rgba(16,19,26,.96);border:1px solid rgba(255,255,255,.14);border-radius:10px;'
    + 'color:#dfe3ea;font:13px/1.5 system-ui,Segoe UI,Microsoft YaHei,sans-serif;padding:14px 16px;'
    + 'box-shadow:0 8px 32px rgba(0,0,0,.5);display:none}'
    + '#ocs-panel.open{display:block}'
    + '#ocs-panel h3{margin:2px 0 10px;font-size:15px;color:#ffb84d}'
    + '#ocs-panel h4{margin:12px 0 6px;font-size:12.5px;color:#8fa3bf;text-transform:uppercase;letter-spacing:.4px}'
    + '#ocs-panel label{display:block;margin:6px 0 2px;color:#aab6c8;font-size:12px}'
    + '#ocs-panel input,#ocs-panel select{width:100%;box-sizing:border-box;background:#0b0e14;border:1px solid #2c3546;'
    + 'border-radius:6px;color:#e6e9ef;padding:6px 8px;font-size:13px}'
    + '#ocs-panel .row{display:flex;gap:8px;align-items:center;margin-top:8px}'
    + '#ocs-panel button{background:#2d6cdf;border:none;border-radius:6px;color:#fff;padding:6px 14px;'
    + 'font-size:13px;cursor:pointer}'
    + '#ocs-panel button.ghost{background:#2a3140}'
    + '#ocs-panel button.danger{background:#a03030}'
    + '#ocs-panel button:hover{filter:brightness(1.15)}'
    + '#ocs-panel .hint{color:#7d8aa0;font-size:11.5px;margin-top:4px;line-height:1.45}'
    + '#ocs-panel .srv{display:flex;justify-content:space-between;align-items:center;background:#131822;'
    + 'border:1px solid #263042;border-radius:6px;padding:5px 8px;margin-top:5px}'
    + '#ocs-panel .srv .n{cursor:pointer;color:#cfe0ff}'
    + '#ocs-panel .srv .n:hover{color:#ffb84d}'
    + '#ocs-panel .ok{color:#6fd66f}#ocs-panel .err{color:#ff7b7b}';

  function buildPanel() {
    if (document.getElementById('ocs-panel')) return;
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var gear = document.createElement('div');
    gear.id = 'ocs-gear';
    gear.title = '离线设置 (F8)';
    gear.textContent = '⚙';
    gear.addEventListener('click', function (e) { e.stopPropagation(); togglePanel(); });
    document.body.appendChild(gear);

    var p = document.createElement('div');
    p.id = 'ocs-panel';
    p.innerHTML =
      '<h3>离线版设置</h3>'
      + '<h4>本地账号 · 无需邮箱验证码</h4>'
      + '<div id="ocs-acct-status" class="hint" style="margin:2px 0 4px"></div>'
      + '<form id="ocs-acct-form">'
      + '<div class="row"><input id="ocs-acct-nick" maxlength="32" placeholder="游戏昵称" style="flex:1">'
      + '<input id="ocs-acct-pass" placeholder="密码(≥6位)" style="flex:0 0 118px" type="password">'
      + '<button type="submit">创建/登录</button></div></form>'
      + '<div id="ocs-acct-tip" class="hint"></div>'
      + '<div class="row"><button class="ghost" id="ocs-acct-logout">退出登录</button>'
      + '<span class="hint" style="margin-left:8px">创建后自动登录, 刷新大厅即生效</span></div>'
      + '<h4>玩家昵称</h4>'
      + '<div class="row"><input id="ocs-name" maxlength="32" placeholder="游戏内昵称">'
      + '<button id="ocs-name-btn">应用</button></div>'
      + '<div class="hint">即引擎 name 变量, 离线即时生效, 无需在线账号。</div>'
      + '<h4>联机中继网关</h4>'
      + '<label>引擎 socket → WebSocket → 本条目指向的网关</label>'
      + '<select id="ocs-relay-sel">'
      + '<option value="local">本地默认 (随本程序内置中继)</option>'
      + '<option value="official">playcs.cc 官方网关 (css.yikm.net, 需联网)</option>'
      + '<option value="custom">自定义…</option>'
      + '</select>'
      + '<div class="row" id="ocs-relay-custom-row" style="display:none">'
      + '<input id="ocs-relay-custom" placeholder="ws://192.168.1.10:8787/websocket/u">'
      + '<button id="ocs-relay-btn">保存</button></div>'
      + '<div class="row"><button class="ghost" id="ocs-relay-test">测试中继连通性</button>'
      + '<span id="ocs-relay-test-result" class="hint" style="margin-left:8px"></span></div>'
      + '<div class="hint">连接时引擎把目标服务器地址追加到基址后:'
      + '<br><code>&lt;基址&gt;/&lt;服务器IP&gt;:&lt;端口&gt;</code>'
      + '<br>官方服务器列表已自动同步(服务器菜单), 它们走官方网关。'
      + '<br>改完对下一次连接生效, 建议重开页面。</div>'
      + '<h4>游戏服务器 · 快速连接</h4>'
      + '<div class="row"><input id="ocs-srv-name" placeholder="备注名" style="flex:0 0 88px">'
      + '<input id="ocs-srv-addr" placeholder="IP:端口 如 192.168.1.5:27015" style="flex:1">'
      + '<input id="ocs-srv-map" placeholder="地图" style="flex:0 0 84px"></div>'
      + '<div class="row"><button id="ocs-srv-add">添加</button>'
      + '<span class="hint" style="margin:0 0 0 8px">需局域网/公网存在真实 CS:S 服务器(内置中继做 WS↔UDP 桥)</span></div>'
      + '<div id="ocs-srv-list"></div>'
      + '<h4>显卡 / 渲染</h4>'
      + '<div id="ocs-gpu" class="hint">检测中…</div>'
      + '<h4>关于</h4>'
      + '<div class="hint">离线增强补丁 v' + '1.1.0' + ' · 换图加载修复 / 本地账号 / 自建中继'
      + '<br>当前中继: <code id="ocs-relay-now"></code></div>';
    document.body.appendChild(p);
    bindPanel(p);
    renderServers();
    refreshRelayNow();
    renderAccountStatus();
    renderGPU();
  }
  function refreshRelayNow() {
    var el = document.getElementById('ocs-relay-now');
    if (el) el.textContent = getRelayUrl();
  }
  function renderAccountStatus() {
    var el = document.getElementById('ocs-acct-status');
    if (!el) return;
    var s = getSession();
    if (s) {
      el.textContent = '✓ 已登录: ' + (s.displayName || s.username) + (s.email && s.email.indexOf('@local.') === 0 ? '' : '');
      el.className = 'hint ok';
    } else {
      el.textContent = '未登录 —— 下方创建即可, 不需要邮箱';
      el.className = 'hint';
    }
  }
  function renderGPU() {
    var el = document.getElementById('ocs-gpu');
    if (!el) return;
    var g = detectGPU();
    if (g.igpu) {
      el.innerHTML = '<span class="err">⚠ 当前渲染: ' + g.name + '</span>'
        + '<br>检测到用核显/软件渲染。双显卡笔记本请重启本程序(首次启动会自动写注册表 GpuPreference=2 强制独显),'
        + '或在 Windows 设置→屏幕→显示卡 中把 PlayCS.exe 设为"高性能"。';
    } else {
      el.innerHTML = '<span class="ok">✓ 独立显卡渲染中</span><br>' + g.name;
    }
  }
  function renderServers() {
    var box = document.getElementById('ocs-srv-list');
    if (!box) return;
    var list = getServers();
    if (!list.length) { box.innerHTML = '<div class="hint">(暂无, 在上方添加)</div>'; return; }
    box.innerHTML = '';
    list.forEach(function (s, i) {
      var row = document.createElement('div');
      row.className = 'srv';
      var n = document.createElement('span');
      n.className = 'n';
      n.textContent = (s.name || s.addr) + '  [' + s.addr + (s.map ? ' · ' + s.map : '') + ']';
      n.title = '点击加入';
      n.addEventListener('click', function () { joinServer(s); });
      var del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '删除';
      del.style.padding = '2px 8px';
      del.addEventListener('click', function () { removeServer(i); renderServers(); });
      row.appendChild(n);
      row.appendChild(del);
      box.appendChild(row);
    });
  }
  function bindPanel(p) {
    // 本地账号: 创建/登录 + 退出
    var acctTip = p.querySelector('#ocs-acct-tip');
    bindQuickCreate(p.querySelector('#ocs-acct-form'), p.querySelector('#ocs-acct-nick'),
      p.querySelector('#ocs-acct-pass'), function (msg, isErr) {
        acctTip.textContent = msg || '';
        acctTip.className = isErr ? 'hint err' : 'hint ok';
      });
    p.querySelector('#ocs-acct-logout').addEventListener('click', function () {
      if (getSession()) localLogout();
      else { acctTip.textContent = '当前未登录'; acctTip.className = 'hint'; }
    });
    var acctNick = p.querySelector('#ocs-acct-nick');
    if (!acctNick.value) acctNick.value = getPlayerName() || randomNick();
    // 中继连通性测试: 同时测本地 + 官方
    var testBtn = p.querySelector('#ocs-relay-test');
    var testRes = p.querySelector('#ocs-relay-test-result');
    testBtn.addEventListener('click', function () {
      testBtn.disabled = true;
      testRes.textContent = '测试中…';
      Promise.all([testRelay(localRelayUrl()), testRelay(RELAY_OFFICIAL)])
        .then(function (rs) {
          var local = rs[0], off = rs[1];
          testRes.innerHTML = '本地: ' + (local.ok ? '<span class="ok">✓ ' + local.ms + 'ms</span>'
              : '<span class="err">✗ ' + (local.err || '失败') + '</span>')
            + ' · 官方: ' + (off.ok ? '<span class="ok">✓ ' + off.ms + 'ms</span>'
              : '<span class="err">✗ ' + (off.err || '失败') + '</span>');
          testBtn.disabled = false;
        });
    });
    var sel = p.querySelector('#ocs-relay-sel');
    var customRow = p.querySelector('#ocs-relay-custom-row');
    var customInput = p.querySelector('#ocs-relay-custom');
    var mode = getRelayMode();
    if (mode === 'official' || mode === 'local') sel.value = mode;
    else { sel.value = 'custom'; customRow.style.display = 'flex'; customInput.value = mode; }
    sel.addEventListener('change', function () {
      customRow.style.display = sel.value === 'custom' ? 'flex' : 'none';
      if (sel.value !== 'custom') { setRelay(sel.value); refreshRelayNow(); }
    });
    p.querySelector('#ocs-relay-btn').addEventListener('click', function () {
      var u = customInput.value.trim();
      if (!/^wss?:\/\//i.test(u)) { customInput.style.borderColor = '#ff7b7b'; return; }
      customInput.style.borderColor = '';
      setRelay(u);
      refreshRelayNow();
    });
    var nameInput = p.querySelector('#ocs-name');
    nameInput.value = getPlayerName();
    p.querySelector('#ocs-name-btn').addEventListener('click', function () {
      var ok = setPlayerName(nameInput.value);
      nameInput.value = getPlayerName();
      var tip = p.querySelector('#ocs-name-tip');
      if (!tip) {
        tip = document.createElement('span');
        tip.id = 'ocs-name-tip';
        tip.className = 'hint';
        nameInput.parentNode.parentNode.appendChild(tip);
      }
      tip.textContent = ok ? '✓ 已生效' : '✓ 已保存 (进入游戏后生效)';
      tip.className = 'ok';
      setTimeout(function () { if (tip) tip.textContent = ''; }, 2500);
    });
    p.querySelector('#ocs-srv-add').addEventListener('click', function () {
      var addr = p.querySelector('#ocs-srv-addr').value.trim();
      if (!/^[a-zA-Z0-9\.\-_]+:\d+$/.test(addr)) {
        p.querySelector('#ocs-srv-addr').style.borderColor = '#ff7b7b';
        return;
      }
      p.querySelector('#ocs-srv-addr').style.borderColor = '';
      addServer(p.querySelector('#ocs-srv-name').value, addr, p.querySelector('#ocs-srv-map').value.trim());
      p.querySelector('#ocs-srv-name').value = '';
      p.querySelector('#ocs-srv-addr').value = '';
      p.querySelector('#ocs-srv-map').value = '';
      renderServers();
    });
  }
  function togglePanel(force) {
    var p = document.getElementById('ocs-panel');
    if (!p) return;
    var open = force !== undefined ? force : !p.classList.contains('open');
    p.classList.toggle('open', open);
  }

  // ------------------------------------------------------------
  // 8. 启动
  // ------------------------------------------------------------
  function boot() {
    applyNameOnBoot();
    buildPanel();
    document.addEventListener('keydown', function (e) {
      if (e.key === 'F8') { e.preventDefault(); togglePanel(); }
    });
    // play.js 的 downloadMap 在其脚本顶层同步定义;
    // 我们在 play.js 之后运行, 直接覆盖即可。保险起见做一次延迟复查。
    if (!patchDownloadMap()) {
      var t = setInterval(function () { if (patchDownloadMap()) clearInterval(t); }, 50);
      setTimeout(function () { clearInterval(t); }, 30000);
    }
    // 引擎就绪后立即应用昵称(覆盖 Guest)
    var nameApplied = 0;
    var t2 = setInterval(function () {
      if (typeof window.engineRunCommand === 'function') {
        var n = getPlayerName();
        if (n) { try { window.engineRunCommand('name "' + n + '"'); } catch (e) {} }
        clearInterval(t2);
      }
      if (++nameApplied > 600) clearInterval(t2); // 最多等 60s
    }, 100);
    // 本地账号引导 + 官方注册表单辅助(仅大厅页需要)
    if (document.getElementById('auth-panel-register') || /\/(index\.html)?$/.test(location.pathname)) {
      setTimeout(offerAccountOverlay, 1200);
      startRegisterAssist();
    }
    console.log('[offline] enhance patch v1.1.0 loaded — F8 打开设置');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
