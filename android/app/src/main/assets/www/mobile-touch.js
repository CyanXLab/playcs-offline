/*
 * PLAYCS 离线版 — 手机触屏控制层 (mobile-touch.js)
 * ============================================================
 * 必须在 play.js 之后加载(依赖 window.engineRunCommand / canvas)。
 * 仅在触屏设备激活, 桌面浏览器零影响。
 *
 * 架构(逆向结论):
 *   - 引擎(Emscripten SDL2)在指针锁定状态下从 document 的 mousemove
 *     事件读取 event.movementX/movementY 写入 HEAP → 视角。
 *   - isLocked() 只读 document.pointerLockElement → 可在 JS 层遮蔽。
 *   - 因此触屏视角 = 合成 MouseEvent(带自有 movementX/Y 属性) 派发到 document。
 *   - 移动/动作 = 引擎控制台命令(+forward/+attack/+jump...) 经
 *     window.engineRunCommand 注入 cbuf(与 bind 按键等价)。
 *
 * 功能:
 *   基础层: 悬浮摇杆(左半屏任意位置按下即出现)、全套按钮、灵敏度/手感曲线、
 *           开火稳枪(开火时视角灵敏度衰减)、轻推静步(摇杆内圈=+speed)、
 *           性能预设(fps_max/cvar/渲染分辨率)、DPR 渲染分辨率上限(防崩第一要务)、
 *   进阶层: 陀螺仪辅助瞄准(devicemotion, 需现场校准)、准星辅助(实验性:
 *           像素采样检测, 命中减速/自动开火)、看门狗(内存/OOM 提示与自动恢复)。
 *
 * 已知边界(如实说明):
 *   - 移动为二值速度(引擎 cbuf 无模拟量入口), 轻推静步用 +speed 补偿;
 *   - 陀螺仪轴向映射依赖 screen.orientation.angle, 不同机型可能需在设置里换轴;
 *   - 准星辅助基于像素颜色, 依赖模型配色, 默认关闭。
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.__MOBILE_TOUCH__) return;
  window.__MOBILE_TOUCH__ = true;

  var isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  if (!isTouch) return; // 桌面端完全不受影响

  // ============================================================
  // 配置与持久化
  // ============================================================
  var LS_KEY = 'mobiletouch.cfg.v1';
  var DEF = {
    sensX: 1.0,          // 视角灵敏度 X (倍)
    sensY: 1.0,          // 视角灵敏度 Y
    curve: 1.4,          // 手感曲线指数 1=线性 1.4=温和 1.8=跟手
    baseSpeed: 0.16,     // 每像素基础角速度(度) — COD 手感约 0.12~0.2
    dead: 0.12,          // 摇杆死区(比例)
    walkR: 0.45,         // 轻推静步半径(比例, 内圈=+speed)
    gyroOn: false,       // 陀螺仪
    gyroSens: 1.0,
    gyroYawAxis: 0,      // 0:beta 1:gamma 2:alpha
    gyroPitchAxis: 1,
    gyroInvertY: false,
    fireSteady: 0.55,    // 开火稳枪: 开火时视角灵敏度乘数(1=不衰减)
    duckToggle: true,    // 蹲下为开关
    assistSlow: false,   // 辅助: 准星命中目标时视角减速
    assistAuto: false,   // 辅助: 准星命中目标自动开火(实验性)
    assistColor: 'r',    // r=T黄褐 c=CT蓝 g=自定义
    assistR: 170, assistG: 140, assistB: 90, assistTol: 60,
    perfPreset: 'mid',   // low/mid/high/native
    resScale: 0.66,      // 渲染分辨率比例(乘以 min(dpr,2))
    dprCap: 2,           // devicePixelRatio 上限 — dpr=3 时渲染量 9 倍, 必须压
    fpsCap: 60,
    autoReloadOOM: true, // 内存濒限时自动重载
    uiScale: 1.0,
    uiOpacity: 0.55
  };
  var CFG = (function () {
    try { var v = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); for (var k in DEF) if (!(k in v)) v[k] = DEF[k]; return v; }
    catch (e) { return JSON.parse(JSON.stringify(DEF)); }
  })();
  function saveCfg() { try { localStorage.setItem(LS_KEY, JSON.stringify(CFG)); } catch (e) {} }

  // ============================================================
  // 指针锁遮罩(引擎视角注入的前提; 不支持的环境自动跳过, 不挡任何东西)
  // ============================================================
  try {
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: function () { return document.getElementById('canvas') || null; }
    });
  } catch (e) { console.warn('[mt] pointerLockElement shadow skipped:', e); }

  // ============================================================
  // 渲染分辨率上限 — 手机 dpr=3 会让渲染量暴涨 9 倍, 是"卡崩"第一元凶
  // 通过遮蔽 canvas 实例的 width/height, 引擎怎么设都会被钳制
  // ============================================================
  function patchCanvasRes() {
    var canvas = document.getElementById('canvas') || document.querySelector('canvas.emscripten');
    if (!canvas || canvas.__mtRes) return !!canvas;
    try {
      var realW = canvas.width, realH = canvas.height;
      function effDpr() { return Math.min(window.devicePixelRatio || 1, CFG.dprCap) * CFG.resScale; }
      function capW() { return Math.max(320, Math.round((canvas.clientWidth || 640) * effDpr())); }
      function capH() { return Math.max(240, Math.round((canvas.clientHeight || 360) * effDpr())); }
      var dw = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
      var dh = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height');
      if (!dw || !dh) return false;
      Object.defineProperty(canvas, 'width', { configurable: true,
        get: function () { return realW; },
        set: function (v) { v = +v || 0; var c = capW(); realW = v > c * 1.02 ? c : v; } });
      Object.defineProperty(canvas, 'height', { configurable: true,
        get: function () { return realH; },
        set: function (v) { v = +v || 0; var c = capH(); realH = v > c * 1.02 ? c : v; } });
      canvas.__mtRes = true;
      return true;
    } catch (e) { console.warn('[mt] res cap failed:', e); return false; }
  }

  // ============================================================
  // 引擎命令桥
  // ============================================================
  var engineReady = false;
  function pollEngine() {
    engineReady = typeof window.engineRunCommand === 'function';
  }
  function cmd(c) {
    if (typeof window.engineRunCommand === 'function') {
      try { window.engineRunCommand(c); return true; } catch (e) {}
    }
    return false;
  }
  var held = {}; // 状态机, 避免重复发 +x
  function pressOn(a) { if (!held[a]) { cmd('+' + a); held[a] = true; } }
  function pressOff(a) { if (held[a]) { cmd('-' + a); held[a] = false; } }
  function tap(a, ms) { pressOn(a); setTimeout(function () { pressOff(a); }, ms || 90); }
  function one(c) { cmd(c); }

  // ============================================================
  // 视角注入 — 合成 mousemove(自有 movementX/Y) 派发到 document
  // ============================================================
  function lookDelta(dx, dy) {
    try {
      var ev = new MouseEvent('mousemove', {
        clientX: innerWidth / 2, clientY: innerHeight / 2, button: 0, buttons: 0
      });
      Object.defineProperty(ev, 'movementX', { value: dx });
      Object.defineProperty(ev, 'movementY', { value: dy });
      document.dispatchEvent(ev);
    } catch (e) {}
  }
  function curve(v) { var s = v < 0 ? -1 : 1, a = Math.abs(v); return s * Math.pow(a, CFG.curve); }
  var firing = false;
  function lookMult() {
    var m = 1;
    if (firing) m *= CFG.fireSteady;      // 开火稳枪
    if (onTarget && CFG.assistSlow) m *= 0.55; // 命中减速(吸附感)
    return m;
  }

  // ============================================================
  // 性能预设
  // ============================================================
  var PRESETS = {
    low:   { resScale: 0.5,  fpsCap: 45, cvars: ['mat_picmip 2', 'r_decals 30', 'r_dynamic 0', 'cl_detaildist 0', 'r_lod 2', 'mat_forceaniso 1', 'mat_reduceparticles 1', 'cl_ragdoll_collide 0', 'r_eyemove 0'] },
    mid:   { resScale: 0.66, fpsCap: 60, cvars: ['mat_picmip 1', 'r_decals 100', 'r_dynamic 0', 'cl_detaildist 400', 'r_lod 1', 'mat_forceaniso 2'] },
    high:  { resScale: 0.8,  fpsCap: 90, cvars: ['mat_picmip 0', 'r_decals 200', 'r_dynamic 1', 'r_lod -1'] },
    native:{ resScale: 1.0,  fpsCap: 0,  cvars: [] }
  };
  function applyPreset(name) {
    var p = PRESETS[name]; if (!p) return;
    CFG.perfPreset = name; CFG.resScale = p.resScale; CFG.fpsCap = p.fpsCap;
    saveCfg();
    var t = 0;
    function flush() {
      if (typeof window.engineRunCommand !== 'function') { if (++t < 300) setTimeout(flush, 200); return; }
      p.cvars.forEach(one);
      one('fps_max ' + (p.fpsCap || 0));
      if (t === 0) setTimeout(flush, 1500); // 引擎完全起来后再补一遍
      t = 1;
    }
    flush();
  }

  // ============================================================
  // 看门狗: 内存 / OOM / 全局异常 (防崩、防卡退)
  // ============================================================
  var lastToast = 0;
  function toast(msg, ms) {
    var now = Date.now(); if (now - lastToast < 1500) return; lastToast = now;
    var el = document.getElementById('mt-toast');
    if (!el) { el = document.createElement('div'); el.id = 'mt-toast';
      el.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483600;background:rgba(20,24,32,.9);color:#ffd479;font:13px/1.5 system-ui,sans-serif;padding:8px 14px;border-radius:8px;pointer-events:none;transition:opacity .3s;opacity:0';
      document.body.appendChild(el); }
    el.textContent = msg; el.style.opacity = '1';
    clearTimeout(el.__t); el.__t = setTimeout(function () { el.style.opacity = '0'; }, ms || 2600);
  }
  window.addEventListener('error', function (e) {
    if (e && e.message && /memory|allocation|abort|OOM/i.test(e.message)) toast('内存不足, 建议在设置中降低性能档位');
  });
  window.addEventListener('unhandledrejection', function () { /* 静默吞掉, 防止引擎异步异常冒泡弹窗 */ });
  var lastReload = 0;
  setInterval(function () {
    var pm = performance.memory;
    if (pm && pm.jsHeapSizeLimit) {
      if (pm.usedJSHeapSize > pm.jsHeapSizeLimit * 0.92 && CFG.autoReloadOOM) {
        if (Date.now() - lastReload > 10 * 60 * 1000) {
          lastReload = Date.now();
          toast('内存接近上限, 5 秒后自动恢复(可回大厅继续)', 4500);
          setTimeout(function () { location.reload(); }, 5000);
        }
      } else if (pm.usedJSHeapSize > pm.jsHeapSizeLimit * 0.8) {
        toast('内存偏高: 关闭后台应用, 或在设置切换"流畅"档');
      }
    }
  }, 4000);

  // ============================================================
  // 陀螺仪辅助瞄准 (devicemotion rotationRate, 单位 度/s)
  // 轴向映射依赖屏幕方向, 提供换轴 + Y 反转以便现场校准
  // ============================================================
  var lastMotionT = 0;
  window.addEventListener('devicemotion', function (e) {
    if (!CFG.gyroOn || !e.rotationRate) return;
    var rr = e.rotationRate;
    var now = e.timeStamp || performance.now();
    var dt = lastMotionT ? Math.min(0.05, (now - lastMotionT) / 1000) : 0.016;
    lastMotionT = now;
    function axis(n) { return n === 0 ? (rr.beta || 0) : n === 1 ? (rr.gamma || 0) : (rr.alpha || 0); }
    var yaw = axis(CFG.gyroYawAxis), pitch = axis(CFG.gyroPitchAxis);
    var m = CFG.gyroSens * lookMult();
    var dx = -yaw * dt * m;
    var dy = (CFG.gyroInvertY ? 1 : -1) * pitch * dt * m;
    if (Math.abs(dx) + Math.abs(dy) > 0.02) lookDelta(dx, dy);
  });

  // ============================================================
  // 准星辅助(实验性): 像素采样检测准星区域是否出现目标色
  // ============================================================
  var onTarget = false, sampleTick = 0;
  var sCv = document.createElement('canvas'); sCv.width = 48; sCv.height = 48;
  var sCtx = sCv.getContext('2d', { willReadFrequently: true });
  function assistColor() {
    if (CFG.assistColor === 'c') return [95, 115, 145];
    if (CFG.assistColor === 'g') return [CFG.assistR, CFG.assistG, CFG.assistB];
    return [170, 140, 90]; // T 黄褐
  }
  function assistSample() {
    var canvas = document.getElementById('canvas');
    if (!canvas || !canvas.width) return;
    try {
      sCtx.drawImage(canvas, canvas.width / 2 - 24, canvas.height / 2 - 24, 48, 48, 0, 0, 48, 48);
      var d = sCtx.getImageData(14, 14, 20, 20).data; // 中心 20x20
      var c = assistColor(), tol = CFG.assistTol, hit = 0, n = 0, any = 0;
      for (var i = 0; i < d.length; i += 4) {
        n++;
        if (d[i] + d[i + 1] + d[i + 2] > 24) any++; // 全黑=采样无效
        if (Math.abs(d[i] - c[0]) < tol && Math.abs(d[i + 1] - c[1]) < tol && Math.abs(d[i + 2] - c[2]) < tol) hit++;
      }
      if (any < n * 0.3) { onTarget = false; return; } // 采样失效(帧缓冲已清)则不启用
      onTarget = hit > n * 0.06;
      if (onTarget && CFG.assistAuto && !firing) { tap('attack', 110); }
    } catch (e) { /* 跨域/尚未渲染: 静默 */ }
  }

  // ============================================================
  // UI: 触控层
  // ============================================================
  var UI = null, joyBase = null, joyKnob = null;
  var moveState = { f: false, b: false, l: false, r: false, walk: false };
  function applyMove(s) {
    if (s.f !== moveState.f) { s.f ? pressOn('forward') : pressOff('forward'); moveState.f = s.f; }
    if (s.b !== moveState.b) { s.b ? pressOn('back') : pressOff('back'); moveState.b = s.b; }
    if (s.l !== moveState.l) { s.l ? pressOn('moveleft') : pressOff('moveleft'); moveState.l = s.l; }
    if (s.r !== moveState.r) { s.r ? pressOn('moveright') : pressOff('moveright'); moveState.r = s.r; }
    if (s.walk !== moveState.walk) { s.walk ? pressOn('speed') : pressOff('speed'); moveState.walk = s.walk; }
  }
  function clearMove() { applyMove({ f: false, b: false, l: false, r: false, walk: false }); }

  function el(tag, css, txt) {
    var e = document.createElement(tag);
    e.style.cssText = css;
    if (txt) e.textContent = txt;
    e.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
    return e;
  }
  function btn(label, sub, onPress, onRelease, extra) {
    var b = el('div', 'display:flex;flex-direction:column;align-items:center;justify-content:center;'
      + 'border-radius:50%;background:rgba(15,19,26,' + CFG.uiOpacity + ');'
      + 'border:1px solid rgba(255,255,255,.25);color:#e8ecf2;'
      + 'font:600 13px/1.1 system-ui,sans-serif;user-select:none;-webkit-user-select:none;'
      + 'touch-action:none;box-shadow:0 2px 10px rgba(0,0,0,.4);'
      + (extra || ''), label + (sub ? '<span style="font-size:9px;font-weight:400;opacity:.7;margin-top:2px">' + sub + '</span>' : ''));
    if (onPress) {
      b.addEventListener('touchstart', function (ev) { ev.preventDefault(); ev.stopPropagation(); b.style.background = 'rgba(60,110,220,.75)'; onPress(ev); }, { passive: false });
    }
    if (onRelease) {
      b.addEventListener('touchend', function (ev) { ev.preventDefault(); ev.stopPropagation(); b.style.background = ''; onRelease(ev); }, { passive: false });
      b.addEventListener('touchcancel', function (ev) { b.style.background = ''; onRelease(ev); }, { passive: false });
    }
    return b;
  }

  function buildUI() {
    if (document.getElementById('mt-root')) return true;
    if (!document.body) return false;
    var s = CFG.uiScale;
    var root = el('div', 'position:fixed;inset:0;z-index:2147483400;touch-action:none;'
      + 'user-select:none;-webkit-user-select:none;pointer-events:none;');
    root.id = 'mt-root';
    document.body.appendChild(root);
    UI = root;

    // ---- 左侧摇杆区(悬浮: 按下处出现) ----
    var joyZone = el('div', 'position:absolute;left:0;top:0;bottom:0;width:44%;pointer-events:auto;touch-action:none;');
    root.appendChild(joyZone);
    joyBase = el('div', 'position:absolute;width:' + (128 * s) + 'px;height:' + (128 * s) + 'px;border-radius:50%;'
      + 'border:2px solid rgba(255,255,255,.35);background:rgba(15,19,26,.35);display:none;pointer-events:none;');
    joyKnob = el('div', 'position:absolute;width:' + (56 * s) + 'px;height:' + (56 * s) + 'px;border-radius:50%;'
      + 'background:rgba(220,228,240,.55);border:1px solid rgba(255,255,255,.5);pointer-events:none;');
    joyBase.appendChild(joyKnob); joyZone.appendChild(joyBase);
    var joyId = null, joyOx = 0, joyOy = 0;
    var JR = 64 * s;
    joyZone.addEventListener('touchstart', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      if (joyId !== null) return;
      var t = ev.changedTouches[0];
      joyId = t.identifier; joyOx = t.clientX; joyOy = t.clientY;
      joyBase.style.display = 'block';
      joyBase.style.left = (joyOx - 64 * s) + 'px'; joyBase.style.top = (joyOy - 64 * s) + 'px';
      joyKnob.style.left = (36 * s) + 'px'; joyKnob.style.top = (36 * s) + 'px';
    }, { passive: false });
    joyZone.addEventListener('touchmove', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      for (var i = 0; i < ev.changedTouches.length; i++) {
        var t = ev.changedTouches[i];
        if (t.identifier !== joyId) continue;
        var dx = t.clientX - joyOx, dy = t.clientY - joyOy;
        var mag = Math.sqrt(dx * dx + dy * dy), cl = Math.min(mag, JR);
        var nx = mag ? dx / mag : 0, ny = mag ? dy / mag : 0;
        joyKnob.style.left = (36 * s + nx * cl) + 'px'; joyKnob.style.top = (36 * s + ny * cl) + 'px';
        var r = cl / JR;
        var st = { f: false, b: false, l: false, r: false, walk: false };
        if (r > CFG.dead) {
          var a = Math.atan2(ny, nx); // -PI..PI, y 向下
          if (r < CFG.walkR) st.walk = true; // 轻推静步
          var deg = a * 180 / Math.PI;
          if (deg > -135 && deg < -45) st.f = true;
          else if (deg > 45 && deg < 135) st.b = true;
          else if (deg >= 135 || deg <= -135) st.l = true;
          else st.r = true;
          // 斜向: 允许前进+侧移
          if (deg > -135 && deg < -45) { if (deg > -135 && deg < -90) st.l = true; else if (deg >= -90 && deg < -45) st.r = true; }
          if (deg > 45 && deg < 135) { if (deg > 45 && deg < 90) st.l = true; else if (deg >= 90 && deg < 135) st.r = true; }
        }
        applyMove(st);
      }
    }, { passive: false });
    function joyEnd(ev) {
      for (var i = 0; i < ev.changedTouches.length; i++) {
        if (ev.changedTouches[i].identifier === joyId) {
          joyId = null; joyBase.style.display = 'none'; clearMove();
        }
      }
    }
    joyZone.addEventListener('touchend', joyEnd, { passive: false });
    joyZone.addEventListener('touchcancel', joyEnd, { passive: false });

    // ---- 右侧视角区 ----
    var lookZone = el('div', 'position:absolute;right:0;top:0;bottom:0;width:56%;pointer-events:auto;touch-action:none;');
    root.appendChild(lookZone);
    var lookId = null, lx = 0, ly = 0, lookMoved = false;
    lookZone.addEventListener('touchstart', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      if (lookId !== null) return;
      var t = ev.changedTouches[0];
      lookId = t.identifier; lx = t.clientX; ly = t.clientY; lookMoved = false;
      requestFullscreenOnce();
    }, { passive: false });
    lookZone.addEventListener('touchmove', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      for (var i = 0; i < ev.changedTouches.length; i++) {
        var t = ev.changedTouches[i];
        if (t.identifier !== lookId) continue;
        var dx = curve(t.clientX - lx), dy = curve(t.clientY - ly);
        lx = t.clientX; ly = t.clientY; lookMoved = true;
        var m = CFG.baseSpeed * lookMult();
        lookDelta(dx * CFG.sensX * m, dy * CFG.sensY * m);
      }
    }, { passive: false });
    function lookEnd(ev) {
      for (var i = 0; i < ev.changedTouches.length; i++) {
        if (ev.changedTouches[i].identifier === lookId) lookId = null;
      }
    }
    lookZone.addEventListener('touchend', lookEnd, { passive: false });
    lookZone.addEventListener('touchcancel', lookEnd, { passive: false });

    // ---- 按钮组(右侧) ----
    var bs = Math.round(62 * s);
    var cluster = el('div', 'position:absolute;right:' + Math.round(14 * s) + 'px;bottom:' + Math.round(90 * s) + 'px;'
      + 'width:' + Math.round(190 * s) + 'px;height:' + Math.round(190 * s) + 'px;pointer-events:none;');
    function put(b, x, y, size) {
      b.style.position = 'absolute'; b.style.left = x + 'px'; b.style.top = y + 'px';
      b.style.pointerEvents = 'auto';
      b.style.width = (size || bs) + 'px'; b.style.height = (size || bs) + 'px';
      cluster.appendChild(b);
    }
    var fireBtn = btn('🔥', '开火', function () { firing = true; pressOn('attack'); },
                      function () { firing = false; pressOff('attack'); },
                      'width:' + Math.round(84 * s) + 'px!important;height:' + Math.round(84 * s) + 'px;background:rgba(160,40,40,' + (CFG.uiOpacity + 0.1) + ')');
    put(fireBtn, Math.round(96 * s), Math.round(80 * s), Math.round(84 * s));
    put(btn('⤒', '跳', function () { pressOn('jump'); }, function () { pressOff('jump'); }), Math.round(30 * s), Math.round(0));
    put(btn('⤓', '蹲', duckPress, duckRelease), Math.round(120 * s), Math.round(0));
    put(btn('⟳', '换弹', function () { tap('reload', 150); }), Math.round(0), Math.round(96 * s), Math.round(52 * s));
    put(btn('✋', '互动', function () { pressOn('use'); }, function () { pressOff('use'); }), Math.round(52 * s), Math.round(110 * s), Math.round(52 * s));
    put(btn('⇄', '切枪', function () { one('invnext'); }), Math.round(110 * s), Math.round(170 * s), Math.round(52 * s));
    root.appendChild(cluster);

    // 蹲: 开关或按住
    var duckHeld = false;
    function duckPress() { if (CFG.duckToggle) { duckHeld = !duckHeld; duckHeld ? pressOn('duck') : pressOff('duck'); } else pressOn('duck'); }
    function duckRelease() { if (!CFG.duckToggle) pressOff('duck'); }

    // ---- 武器快捷条(底部中间) ----
    var wbar = el('div', 'position:absolute;left:50%;transform:translateX(-50%);bottom:' + Math.round(10 * s) + 'px;'
      + 'display:flex;gap:' + Math.round(8 * s) + 'px;pointer-events:auto;touch-action:none;');
    [['1', '主武', 'slot1'], ['2', '手枪', 'slot2'], ['3', '刀', 'slot3'], ['Q', '切换', 'lastinv'],
     ['G', '丢弃', 'drop'], ['B', '购买', 'buymenu'], ['T', '喷漆', 'impulse 201']].forEach(function (w) {
      var b = el('div', 'min-width:' + Math.round(44 * s) + 'px;padding:' + Math.round(6 * s) + 'px;'
        + 'border-radius:8px;background:rgba(15,19,26,' + CFG.uiOpacity + ');border:1px solid rgba(255,255,255,.25);'
        + 'color:#e8ecf2;font:600 12px/1.2 system-ui,sans-serif;text-align:center;touch-action:none;', w[0] + '<br><span style="font-size:9px;opacity:.7">' + w[1] + '</span>');
      b.addEventListener('touchstart', function (ev) { ev.preventDefault(); ev.stopPropagation(); one(w[2]); }, { passive: false });
      wbar.appendChild(b);
    });
    root.appendChild(wbar);

    // ---- 记分板(按住) + 菜单 ----
    var topbar = el('div', 'position:absolute;top:' + Math.round(10 * s) + 'px;right:' + Math.round(10 * s) + 'px;'
      + 'display:flex;gap:' + Math.round(8 * s) + 'px;pointer-events:auto;');
    var scoreBtn = btn('TAB', '计分', function () { pressOn('showscores'); }, function () { pressOff('showscores'); });
    scoreBtn.style.width = Math.round(56 * s) + 'px'; scoreBtn.style.height = Math.round(44 * s) + 'px';
    scoreBtn.style.borderRadius = '10px';
    var menuBtn = btn('⚙', '设置', function () { openPanel(); });
    menuBtn.style.width = Math.round(56 * s) + 'px'; menuBtn.style.height = Math.round(44 * s) + 'px';
    menuBtn.style.borderRadius = '10px';
    topbar.appendChild(scoreBtn); topbar.appendChild(menuBtn);
    root.appendChild(topbar);

    buildPanel();
    return true;
  }

  // ============================================================
  // 设置面板
  // ============================================================
  function buildPanel() {
    if (document.getElementById('mt-panel')) return;
    var css = document.createElement('style');
    css.textContent = '#mt-panel{position:fixed;inset:auto 0 0 0;top:auto;z-index:2147483500;max-height:72vh;overflow:auto;'
      + 'background:rgba(14,17,24,.97);color:#dfe3ea;font:13px/1.5 system-ui,sans-serif;padding:14px 18px;display:none;'
      + 'border-top:1px solid rgba(255,255,255,.15)}#mt-panel.open{display:block}'
      + '#mt-panel h3{margin:0 0 8px;color:#ffb84d;font-size:15px}'
      + '#mt-panel h4{margin:10px 0 4px;font-size:12px;color:#8fa3bf;letter-spacing:.4px}'
      + '#mt-panel label{display:flex;justify-content:space-between;align-items:center;margin:4px 0}'
      + '#mt-panel input[type=range]{flex:1;margin-left:10px}'
      + '#mt-panel .row{display:flex;gap:6px;flex-wrap:wrap;margin:4px 0}'
      + '#mt-panel button{background:#2d6cdf;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:13px}'
      + '#mt-panel button.on{background:#3aa06a}'
      + '#mt-panel .hint{color:#7d8aa0;font-size:11.5px}';
    document.head.appendChild(css);
    var p = document.createElement('div'); p.id = 'mt-panel';
    p.innerHTML =
      '<h3>触屏设置 (PlayCS Mobile)</h3>'
      + '<h4>视角</h4>'
      + '<label>灵敏度 X<input id="mt-sx" type="range" min="0.2" max="3" step="0.05"></label>'
      + '<label>灵敏度 Y<input id="mt-sy" type="range" min="0.2" max="3" step="0.05"></label>'
      + '<label>手感曲线<input id="mt-curve" type="range" min="1" max="2" step="0.1"></label>'
      + '<label>开火稳枪(开火灵敏度)<input id="mt-steady" type="range" min="0.2" max="1" step="0.05"></label>'
      + '<h4>摇杆</h4>'
      + '<label>死区<input id="mt-dead" type="range" min="0" max="0.3" step="0.02"></label>'
      + '<label>轻推静步半径<input id="mt-walk" type="range" min="0.2" max="0.7" step="0.05"></label>'
      + '<h4>陀螺仪辅助瞄准</h4>'
      + '<div class="row"><button id="mt-gyro">开/关</button>'
      + '<label style="flex:1">灵敏度<input id="mt-gs" type="range" min="0.2" max="3" step="0.1"></label></div>'
      + '<label>偏航轴<select id="mt-gyaw"><option value="0">beta(X)</option><option value="1">gamma(Y)</option><option value="2">alpha(Z)</option></select>'
      + '　俯仰轴<select id="mt-gpitch"><option value="0">beta(X)</option><option value="1">gamma(Y)</option><option value="2">alpha(Z)</option></select>'
      + '　<button id="mt-ginv">Y反转</button></label>'
      + '<div class="hint">不同机型轴向不同: 打开后转动手机, 视角方向不对就在这里换轴。</div>'
      + '<h4>辅助(实验性)</h4>'
      + '<div class="row"><button id="mt-aslow">命中减速</button><button id="mt-aauto">自动开火</button>'
      + '<select id="mt-acol"><option value="r">目标色:T黄褐</option><option value="c">目标色:CT蓝</option><option value="g">自定义</option></select></div>'
      + '<div class="hint">基于准星区域像素颜色检测, 依赖模型配色, 误判请关闭。</div>'
      + '<h4>性能(防卡防崩)</h4>'
      + '<div class="row"><button data-p="low">流畅</button><button data-p="mid">均衡</button>'
      + '<button data-p="high">高清</button><button data-p="native">原生</button></div>'
      + '<div class="hint">流畅=渲染分辨率50%+45fps+低画质cvar; 渲染分辨率按 min(dpr,2)×比例钳制,'
      + ' 防止 dpr=3 手机渲染量暴涨 9 倍导致卡崩。</div>'
      + '<h4>界面</h4>'
      + '<label>按钮大小<input id="mt-us" type="range" min="0.8" max="1.4" step="0.05"></label>'
      + '<label>不透明度<input id="mt-op" type="range" min="0.25" max="0.9" step="0.05"></label>'
      + '<div class="row"><button id="mt-done">完成</button>'
      + '<span class="hint" style="margin-left:8px">修改即保存, 部分项重建界面后生效</span></div>';
    document.body.appendChild(p);
    var $ = function (id) { return p.querySelector(id); };
    function bindRange(id, key, fmt) {
      var r = $(id); r.value = CFG[key];
      var out = document.createElement('span');
      r.parentNode.insertBefore(out, r); out.style.cssText = 'min-width:36px;text-align:right;color:#9fb6d8';
      out.textContent = fmt ? fmt(CFG[key]) : CFG[key];
      r.addEventListener('input', function () {
        CFG[key] = parseFloat(r.value); out.textContent = fmt ? fmt(CFG[key]) : CFG[key]; saveCfg();
      });
    }
    bindRange('#mt-sx', 'sensX'); bindRange('#mt-sy', 'sensY');
    bindRange('#mt-curve', 'curve'); bindRange('#mt-steady', 'fireSteady');
    bindRange('#mt-dead', 'dead'); bindRange('#mt-walk', 'walkR');
    bindRange('#mt-gs', 'gyroSens');
    bindRange('#mt-us', 'uiScale'); bindRange('#mt-op', 'uiOpacity');
    function syncBtns() {
      $('#mt-gyro').classList.toggle('on', CFG.gyroOn);
      $('#mt-ginv').classList.toggle('on', CFG.gyroInvertY);
      $('#mt-aslow').classList.toggle('on', CFG.assistSlow);
      $('#mt-aauto').classList.toggle('on', CFG.assistAuto);
      $('#mt-acol').value = CFG.assistColor;
      $('#mt-gyaw').value = CFG.gyroYawAxis; $('#mt-gpitch').value = CFG.gyroPitchAxis;
    }
    $('#mt-gyro').addEventListener('click', function () { CFG.gyroOn = !CFG.gyroOn; saveCfg(); syncBtns(); if (CFG.gyroOn) toast('陀螺仪已开启, 转动手机测试方向'); });
    $('#mt-ginv').addEventListener('click', function () { CFG.gyroInvertY = !CFG.gyroInvertY; saveCfg(); syncBtns(); });
    $('#mt-gyaw').addEventListener('change', function () { CFG.gyroYawAxis = +$('#mt-gyaw').value; saveCfg(); });
    $('#mt-gpitch').addEventListener('change', function () { CFG.gyroPitchAxis = +$('#mt-gpitch').value; saveCfg(); });
    $('#mt-aslow').addEventListener('click', function () { CFG.assistSlow = !CFG.assistSlow; saveCfg(); syncBtns(); });
    $('#mt-aauto').addEventListener('click', function () { CFG.assistAuto = !CFG.assistAuto; saveCfg(); syncBtns(); });
    $('#mt-acol').addEventListener('change', function () { CFG.assistColor = $('#mt-acol').value; saveCfg(); });
    p.querySelectorAll('[data-p]').forEach(function (b) {
      b.addEventListener('click', function () {
        applyPreset(b.getAttribute('data-p'));
        toast('性能预设: ' + b.textContent + (b.getAttribute('data-p') !== 'native' ? '(重进地图后完全生效)' : ''));
      });
    });
    $('#mt-done').addEventListener('click', function () { p.classList.remove('open'); saveCfg(); });
    syncBtns();
  }
  function openPanel() { var p = document.getElementById('mt-panel'); if (p) p.classList.toggle('open'); }

  // ============================================================
  // 全屏 + 屏幕常亮 (PWA/WebView 通用)
  // ============================================================
  var fsDone = false;
  function requestFullscreenOnce() {
    if (fsDone) return; fsDone = true;
    try {
      var de = document.documentElement;
      var fn = de.requestFullscreen || de.webkitRequestFullscreen;
      if (fn && !document.fullscreenElement) { var r = fn.call(de); if (r && r.catch) r.catch(function () {}); }
    } catch (e) {}
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').catch(function () {});
    } catch (e) {}
    try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {}); } catch (e) {}
  }

  // ============================================================
  // 启动
  // ============================================================
  var uiT = setInterval(function () {
    if (buildUI()) {
      clearInterval(uiT);
      patchCanvasRes();
      setInterval(function () { if (patchCanvasRes()) return; }, 1000); // 引擎可能重建 canvas
      applyPreset(CFG.perfPreset);
      console.log('[mt] mobile touch layer ready');
    }
  }, 300);
  setTimeout(function () { clearInterval(uiT); }, 60000);

  // 阻断原生缩放/滚动/长按菜单
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  document.addEventListener('dblclick', function (e) { e.preventDefault(); });
  var st = document.createElement('style');
  st.textContent = 'html,body{overscroll-behavior:none;touch-action:none;}'
    + 'canvas.emscripten{touch-action:none!important;}';
  document.head.appendChild(st);

  // 主循环: 辅助采样
  function loop() {
    if ((CFG.assistSlow || CFG.assistAuto) && ++sampleTick % 8 === 0) assistSample();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // 调试 API
  window.MobileTouch = {
    cmd: one, press: tap, cfg: CFG, save: saveCfg,
    applyPreset: applyPreset, rebuild: function () { var r = document.getElementById('mt-root'); if (r) r.remove(); buildUI(); },
    version: '1.0.0'
  };
})();
