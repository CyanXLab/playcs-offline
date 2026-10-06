/*
 * PLAYCS 手机触控层 (touch-controls.js)
 * ============================================================
 * 必须在 play.js 之后加载。桌面端不激活（首次 touchstart 才点亮）。
 *
 * 基础层:
 *   - 左侧悬浮摇杆 → 合成 WASD 键盘事件
 *   - 右侧滑动视角 → 合成 MouseEvent('mousemove') 带 movementX/Y（无需指针锁）
 *   - 全套按钮: 开火/跳/蹲(按住)/换弹/使用/静步开关/切枪(滚轮事件)
 *   - 灵敏度、死区、渲染分辨率上限(dpr 劫持)、性能 cvar
 *
 * 进阶层:
 *   1. 陀螺仪瞄准: devicemotion.rotationRate → 屏幕方向映射 → yaw/pitch,
 *      iOS 13+ 需按钮点击触发 requestPermission()
 *   2. 开火稳枪: 按住开火时视角灵敏度乘 fireSteady 倍率(<1 更稳)
 *   3. 手感曲线: |v|^gamma 幂曲线(gamma<1 近距离跟手, >1 远距离精修) + 死区
 *   4. 轻推静步: 摇杆偏移 < walkTh 时自动叠加 Shift(慢走), 走廊静步不用再按开关
 *   5. 性能预设: 省/均/高 三档 = dpr 上限 + fps_max + 可选附加 cvar
 *
 * 设置面板注入 #ocs-panel(offline-enhance.js)的「手机触控」分区；
 * 该脚本不存在时自动建独立面板(右下角 ● 按钮)。
 * 控制台 API: window.TouchCS
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.__TOUCH_CS__) return;
  window.__TOUCH_CS__ = true;

  // ============================================================
  // 0. 设置存储
  // ============================================================
  var DEF = {
    sens: 1.0,          // 视角灵敏度 (movement 单位 / css px)
    gamma: 1.0,         // 手感曲线幂 (0.5~2)
    deadzone: 0.06,     // 摇杆死区 (0~1)
    walkTh: 0.45,       // 轻推静步阈值 (偏移比例, 0=关闭)
    fireSteady: 0.65,   // 开火稳枪倍率 (0.3~1)
    fireSteadyOn: 1,    // 开火稳枪开关
    gyroOn: 0,          // 陀螺仪开关
    gyroSens: 1.0,      // 陀螺仪灵敏度
    gyroInvertX: 0, gyroInvertY: 0,
    maxDpr: 1.5,        // 渲染分辨率上限 (css px * maxDpr)
    fpsMax: 60,         // fps_max
    extraCvars: ''      // 附加 cvar, 每行一条, 进图后执行
  };
  var LS = 'touch.settings';
  var S = (function () {
    try { var v = JSON.parse(localStorage.getItem(LS) || '{}'); for (var k in DEF) if (!(k in v)) v[k] = DEF[k]; return v; }
    catch (e) { return JSON.parse(JSON.stringify(DEF)); }
  })();
  function saveS() { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) {} }

  // ============================================================
  // 1. 状态
  // ============================================================
  var active = false;          // 首次触摸后激活
  var firing = false;          // 开火键按住(稳枪判定)
  var keys = {};               // 我们合成的键 {code:true}
  var walkToggle = false;      // 静步开关
  var stick = { id: null, cx: 0, cy: 0, dx: 0, dy: 0 };
  var lookId = null, lookX = 0, lookY = 0;
  var gyroLast = 0;
  var cmdQueue = [];

  var canvas = null;
  function getCanvas() {
    if (canvas && canvas.isConnected) return canvas;
    canvas = document.getElementById('canvas');
    return canvas;
  }

  // ============================================================
  // 2. 合成事件工具
  // ============================================================
  function keyCodeOf(ev, kc) { try { Object.defineProperty(ev, 'keyCode', { value: kc }); Object.defineProperty(ev, 'which', { value: kc }); } catch (e) {} return ev; }
  function keyEvent(type, code, kc, key) {
    var c = getCanvas(); if (!c) return;
    var ev = new KeyboardEvent(type, { key: key, code: code, bubbles: true, cancelable: true });
    keyCodeOf(ev, kc);
    c.dispatchEvent(ev);
  }
  function holdKey(code, kc, key, down) {
    if (!!keys[code] === !!down) return;
    keys[code] = down;
    keyEvent(down ? 'keydown' : 'keyup', code, kc, key);
  }
  function releaseAllKeys() {
    for (var c in keys) if (keys[c]) {
      var map = { KeyW: ['w', 87], KeyA: ['a', 65], KeyS: ['s', 83], KeyD: ['d', 68], ShiftLeft: ['Shift', 16] };
      if (map[c]) keyEvent('keyup', c, map[c][1], map[c][0]);
      keys[c] = false;
    }
  }
  function mouseButton(down) {
    var c = getCanvas(); if (!c) return;
    c.dispatchEvent(new MouseEvent(down ? 'mousedown' : 'mouseup', { button: 0, buttons: down ? 1 : 0, clientX: 0, clientY: 0, bubbles: true, cancelable: true }));
  }
  function wheelMove(dir) {
    var c = getCanvas(); if (!c) return;
    c.dispatchEvent(new WheelEvent('wheel', { deltaY: dir * 120, bubbles: true, cancelable: true }));
  }

  // ============================================================
  // 3. 视角管线: 死区(摇杆) → 手感曲线 → 稳枪倍率 → 灵敏度 → movementX/Y
  // ============================================================
  function pow(v, g) { return v < 0 ? -Math.pow(-v, g) : Math.pow(v, g); }
  function dispatchLook(mx, my) {
    var c = getCanvas(); if (!c) return;
    c.dispatchEvent(new MouseEvent('mousemove', {
      movementX: mx, movementY: my, screenX: 0, screenY: 0, clientX: 0, clientY: 0, buttons: firing ? 1 : 0, bubbles: true
    }));
  }
  function applyLook(dx, dy) {
    var g = +S.gamma || 1;
    dx = pow(dx, g); dy = pow(dy, g);
    if (firing && S.fireSteadyOn) { dx *= S.fireSteady; dy *= S.fireSteady; }
    dispatchLook(dx * S.sens, dy * S.sens);
  }
  // 摇杆 → WASD + 轻推静步
  function applyStick(nx, ny) { // nx,ny ∈ [-1,1]
    var mag = Math.hypot(nx, ny);
    var dz = +S.deadzone || 0;
    if (mag < dz) { holdKey('KeyW', 87, 'w', false); holdKey('KeyA', 65, 'a', false); holdKey('KeyS', 83, 's', false); holdKey('KeyD', 68, 'd', false); setAutoWalk(false); return; }
    var t = Math.min(1, (mag - dz) / (1 - dz));
    var ax = nx / (mag || 1), ay = ny / (mag || 1);
    holdKey('KeyW', 87, 'w', ay < -0.38);
    holdKey('KeyS', 83, 's', ay > 0.38);
    holdKey('KeyA', 65, 'a', ax < -0.38);
    holdKey('KeyD', 68, 'd', ax > 0.38);
    // 轻推静步: 偏移小于阈值 → 慢走
    var autoWalk = S.walkTh > 0 && mag < S.walkTh;
    setAutoWalk(autoWalk);
  }
  function setAutoWalk(on) {
    var eff = on || walkToggle;
    holdKey('ShiftLeft', 16, 'Shift', eff);
  }

  // ============================================================
  // 4. 陀螺仪
  // ============================================================
  function mapGyro(x, y) { // x=rotationRate.beta, y=rotationRate.gamma (deg/s)
    var a = 0;
    try { a = (screen.orientation && screen.orientation.angle) || window.orientation || 0; } catch (e) {}
    a = ((a % 360) + 360) % 360;
    var yaw, pitch;
    switch (a) {
      case 90:  yaw = -x; pitch = y;  break;
      case 180: yaw = -y; pitch = -x; break;
      case 270: yaw = x;  pitch = -y; break;
      default:  yaw = y;  pitch = x;  break;
    }
    if (S.gyroInvertX) yaw = -yaw;
    if (S.gyroInvertY) pitch = -pitch;
    return { yaw: yaw, pitch: pitch };
  }
  function onMotion(e) {
    if (!active || !S.gyroOn || !e.rotationRate) return;
    var now = performance.now();
    var dt = gyroLast ? (now - gyroLast) / 1000 : 0;
    gyroLast = now;
    if (dt <= 0 || dt > 0.2) return;
    var r = e.rotationRate, x = r.beta || 0, y = r.gamma || 0;
    var m = mapGyro(x, y);
    // deg/s × dt = 本次转角; 1° ≈ 8 movement px, 总量由 gyroSens 控制
    var k = 8 * dt * S.gyroSens;
    if (firing && S.fireSteadyOn) { m.yaw *= S.fireSteady; m.pitch *= S.fireSteady; }
    dispatchLook(m.yaw * k, m.pitch * k);
  }
  async function enableGyro() {
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        var st = await DeviceMotionEvent.requestPermission();
        if (st !== 'granted') return 'denied';
      }
    } catch (e) { return 'error'; }
    if (!S.gyroOn) { S.gyroOn = 1; saveS(); }
    gyroLast = 0;
    return 'ok';
  }
  function disableGyro() { S.gyroOn = 0; saveS(); }

  // ============================================================
  // 5. 渲染分辨率上限 (dpr 劫持) + 性能 cvar
  // ============================================================
  var dprPatched = false, descW = null, descH = null;
  function patchDprCap() {
    var c = getCanvas();
    if (!c || dprPatched) return;
    dprPatched = true;
    ['width', 'height'].forEach(function (prop) {
      var desc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, prop);
      if (prop === 'width') descW = desc; else descH = desc;
      Object.defineProperty(c, prop, {
        get: function () { return desc.get.call(c); },
        set: function (v) {
          v = +v || 0;
          var css = prop === 'width' ? (c.clientWidth || window.innerWidth) : (c.clientHeight || window.innerHeight);
          var lim = Math.max(320, Math.round(css * (+S.maxDpr || 2)));
          desc.set.call(c, Math.min(v, lim));
        },
        configurable: true
      });
    });
    console.log('[touch] canvas dpr cap:', S.maxDpr);
    // 立即重钳当前后备缓冲(引擎在 resize/rAF 时会重设, 这里兜底已超限的值)
    try { c.width = descW.get.call(c); c.height = descH.get.call(c); } catch (e) {}
  }
  function tcRun(cmd) {
    if (typeof window.engineRunCommand === 'function') { try { window.engineRunCommand(cmd); return; } catch (e) {} }
    cmdQueue.push(cmd);
  }
  (function flush() {
    if (typeof window.engineRunCommand === 'function') {
      while (cmdQueue.length) { try { window.engineRunCommand(cmdQueue.shift()); } catch (e) { break; } }
    }
    setTimeout(flush, 200);
  })();
  function applyPerf() {
    patchDprCap();
    tcRun('fps_max ' + (S.fpsMax | 0));
    // dpr 改动后让引擎按新上限重建后备缓冲
    var c = getCanvas();
    if (c) { try { window.dispatchEvent(new Event('resize')); } catch (e) {} }
    if (S.extraCvars) S.extraCvars.split(/[\n;]+/).forEach(function (l) { l = l.trim(); if (l) tcRun(l); });
  }
  var PRESETS = {
    low:  { label: '省电', maxDpr: 1.0,  fpsMax: 60,  extra: 'r_dynamic 0' },
    mid:  { label: '均衡', maxDpr: 1.5,  fpsMax: 90,  extra: '' },
    high: { label: '高清', maxDpr: 2.0,  fpsMax: 144, extra: '' }
  };
  function applyPreset(name) {
    var p = PRESETS[name]; if (!p) return;
    S.maxDpr = p.maxDpr; S.fpsMax = p.fpsMax;
    if (p.extra) S.extraCvars = S.extraCvars || p.extra;
    saveS(); applyPerf();
  }

  // ============================================================
  // 6. 触控 HUD (摇杆 + 按钮)
  // ============================================================
  var CSS = ''
    + '.tc-root{position:fixed;inset:0;z-index:2147482000;pointer-events:none;display:none;'
    + 'font-family:system-ui,Segoe UI,Microsoft YaHei,sans-serif;user-select:none;-webkit-user-select:none;touch-action:none}'
    + '.tc-root.on{display:block}'
    + '.tc-stick-base{position:absolute;width:120px;height:120px;border-radius:50%;'
    + 'background:rgba(255,255,255,.06);border:2px solid rgba(255,255,255,.25);'
    + 'transform:translate(-50%,-50%);display:none;pointer-events:none}'
    + '.tc-stick-knob{position:absolute;width:52px;height:52px;border-radius:50%;left:50%;top:50%;'
    + 'background:rgba(255,255,255,.28);border:1px solid rgba(255,255,255,.5);'
    + 'transform:translate(-50%,-50%);pointer-events:none}'
    + '.tc-btn{position:absolute;pointer-events:auto;border-radius:50%;'
    + 'background:rgba(20,24,32,.5);border:1.5px solid rgba(255,255,255,.35);color:#fff;'
    + 'display:flex;align-items:center;justify-content:center;text-align:center;'
    + 'font-size:13px;font-weight:700;backdrop-filter:blur(2px);opacity:.85;touch-action:none}'
    + '.tc-btn.press{background:rgba(255,184,77,.45);border-color:#ffb84d}'
    + '.tc-btn.toggled{background:rgba(90,180,90,.45);border-color:#7fd67f}'
    + '.tc-fire{width:92px;height:92px;font-size:16px;background:rgba(160,48,48,.4);border-color:rgba(255,120,120,.5)}'
    + '.tc-fire.press{background:rgba(255,90,90,.55)}'
    + '.tc-s{width:58px;height:58px;font-size:12px}'
    + '.tc-xs{width:46px;height:46px;font-size:11px}'
    + '#tc-gyro{position:absolute;right:14px;top:14px;width:44px;height:44px;font-size:16px;border-radius:10px}'
    + '.tc-tip{position:absolute;left:50%;top:12%;transform:translateX(-50%);color:#ffd;opacity:.75;font-size:12px;pointer-events:none;text-shadow:0 1px 2px #000}';

  var BTN_LAYOUT = [ // [id, label, cls, right, bottom]
    ['fire',   '开火', 'tc-fire', 'right:18px;bottom:110px', 0],
    ['jump',   '跳',   'tc-s',    'right:126px;bottom:52px', 0],
    ['crouch', '蹲',   'tc-s',    'right:130px;bottom:130px', 0],
    ['reload', '换弹', 'tc-xs',   'right:132px;bottom:204px', 0],
    ['use',    '用',   'tc-xs',   'right:58px;bottom:222px', 0],
    ['walk',   '静步', 'tc-xs',   'right:20px;bottom:30px', 1],
    ['wprev',  '◂枪',  'tc-xs',   'right:206px;bottom:70px', 0],
    ['wnext',  '枪▸',  'tc-xs',   'right:206px;bottom:140px', 0]
  ];
  var root, knobEl, baseEl;

  function buildHUD() {
    if (root) return;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement('div'); root.className = 'tc-root';
    baseEl = document.createElement('div'); baseEl.className = 'tc-stick-base';
    knobEl = document.createElement('div'); knobEl.className = 'tc-stick-knob';
    baseEl.appendChild(knobEl); root.appendChild(baseEl);
    var tip = document.createElement('div'); tip.className = 'tc-tip';
    tip.textContent = '左半屏摇杆移动 · 右半屏滑动视角 · 轻推=静步';
    root.appendChild(tip); setTimeout(function () { tip.remove(); }, 6000);

    BTN_LAYOUT.forEach(function (b) {
      var el = document.createElement('div');
      el.className = 'tc-btn ' + b[2]; el.id = 'tc-' + b[0];
      el.setAttribute('style', b[3]);
      el.textContent = b[1];
      bindBtn(el, b[0], b[4]);
      root.appendChild(el);
    });
    var gyro = document.createElement('div');
    gyro.className = 'tc-btn'; gyro.id = 'tc-gyro'; gyro.textContent = '陀螺';
    gyro.addEventListener('touchstart', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (S.gyroOn) { disableGyro(); gyro.classList.remove('toggled'); }
      else enableGyro().then(function (r) { gyro.classList.toggle('toggled', r === 'ok'); });
    }, { passive: false });
    root.appendChild(gyro);
    document.body.appendChild(root);
  }
  function bindBtn(el, id, isToggle) {
    el.addEventListener('touchstart', function (e) {
      e.preventDefault(); e.stopPropagation();
      el.classList.add('press');
      switch (id) {
        case 'fire': firing = true; mouseButton(true); break;
        case 'jump': keyEvent('keydown', 'Space', 32, ' '); break;
        case 'crouch': holdKey('ControlLeft', 17, 'Control', true); break;
        case 'reload': keyEvent('keydown', 'KeyR', 82, 'r'); break;
        case 'use': keyEvent('keydown', 'KeyE', 69, 'e'); break;
        case 'walk': if (isToggle) { walkToggle = !walkToggle; setAutoWalk(walkToggle); el.classList.toggle('toggled', walkToggle); } break;
        case 'wprev': wheelMove(-1); break;
        case 'wnext': wheelMove(1); break;
      }
    }, { passive: false });
    var up = function (e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      el.classList.remove('press');
      switch (id) {
        case 'fire': firing = false; mouseButton(false); break;
        case 'jump': keyEvent('keyup', 'Space', 32, ' '); break;
        case 'crouch': holdKey('ControlLeft', 17, 'Control', false); break;
        case 'reload': keyEvent('keyup', 'KeyR', 82, 'r'); break;
        case 'use': keyEvent('keyup', 'KeyE', 69, 'e'); break;
      }
    };
    el.addEventListener('touchend', up, { passive: false });
    el.addEventListener('touchcancel', up, { passive: false });
  }

  // ============================================================
  // 7. 触摸路由: 左半屏=摇杆, 右半屏=视角, 按钮/面板自吞
  // ============================================================
  function inUI(t) {
    var n = t.target;
    while (n && n !== document.body) {
      if (n.classList && (n.classList.contains('tc-btn') || n.id === 'ocs-panel' || n.id === 'ocs-gear')) return true;
      n = n.parentNode;
    }
    return false;
  }
  function activate() {
    if (active) return;
    active = true;
    buildHUD();
    root.classList.add('on');
    patchDprCap();
    console.log('[touch] mobile layer activated');
  }
  function onTouchStart(e) {
    if (e.touches.length && !active) activate();
    if (!active) return;
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      if (inUI(t)) continue;
      if (t.clientX < window.innerWidth * 0.45) {
        if (stick.id !== null) continue;
        stick.id = t.identifier; stick.cx = t.clientX; stick.cy = t.clientY; stick.dx = 0; stick.dy = 0;
        baseEl.style.display = 'block';
        baseEl.style.left = stick.cx + 'px'; baseEl.style.top = stick.cy + 'px';
        knobEl.style.transform = 'translate(-50%,-50%)';
      } else {
        if (lookId !== null) continue;
        lookId = t.identifier; lookX = t.clientX; lookY = t.clientY;
        try { getCanvas() && getCanvas().requestPointerLock && getCanvas().requestPointerLock(); } catch (err) {}
      }
    }
    if (e.cancelable) e.preventDefault();
  }
  function onTouchMove(e) {
    if (!active) return;
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      if (t.identifier === stick.id) {
        var R = 60;
        var dx = t.clientX - stick.cx, dy = t.clientY - stick.cy;
        var mag = Math.hypot(dx, dy);
        if (mag > R) { dx = dx / mag * R; dy = dy / mag * R; }
        stick.dx = dx / R; stick.dy = dy / R;
        knobEl.style.transform = 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px))';
        applyStick(stick.dx, stick.dy);
      } else if (t.identifier === lookId) {
        var mx = t.clientX - lookX, my = t.clientY - lookY;
        lookX = t.clientX; lookY = t.clientY;
        if (mx || my) applyLook(mx, my);
      }
    }
    if (e.cancelable) e.preventDefault();
  }
  function onTouchEnd(e) {
    if (!active) return;
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      if (t.identifier === stick.id) {
        stick.id = null; baseEl.style.display = 'none';
        applyStick(0, 0);
      } else if (t.identifier === lookId) lookId = null;
    }
  }
  function bindTouch() {
    var opt = { passive: false };
    document.addEventListener('touchstart', onTouchStart, opt);
    document.addEventListener('touchmove', onTouchMove, opt);
    document.addEventListener('touchend', onTouchEnd, opt);
    document.addEventListener('touchcancel', onTouchEnd, opt);
  }

  // ============================================================
  // 8. 设置面板 (注入 #ocs-panel, 否则独立面板)
  // ============================================================
  var SEC_HTML =
    '<h4>手机触控 · 性能预设</h4>'
    + '<div class="row">'
    + '<button id="tc-p-low" class="ghost" style="flex:1">省电</button>'
    + '<button id="tc-p-mid" class="ghost" style="flex:1">均衡</button>'
    + '<button id="tc-p-high" class="ghost" style="flex:1">高清</button>'
    + '</div>'
    + '<div class="hint">省电 dpr1.0/60fps · 均衡 dpr1.5/90fps · 高清 dpr2.0/144fps。手机 dpr=3 不加限制会 9 倍渲染量。</div>'
    + '<h4>手机触控 · 手感</h4>'
    + '<label>视角灵敏度 <span id="tc-v-sens"></span></label>'
    + '<input type="range" id="tc-sens" min="0.2" max="3" step="0.05">'
    + '<label>手感曲线 γ (<1 跟手 / >1 精修) <span id="tc-v-gamma"></span></label>'
    + '<input type="range" id="tc-gamma" min="0.5" max="2" step="0.05">'
    + '<label>开火稳枪倍率 (越小越稳) <span id="tc-v-steady"></span></label>'
    + '<input type="range" id="tc-steady" min="0.3" max="1" step="0.05">'
    + '<label>轻推静步阈值 (0=关闭) <span id="tc-v-walk"></span></label>'
    + '<input type="range" id="tc-walk" min="0" max="0.9" step="0.05">'
    + '<label>摇杆死区 <span id="tc-v-dz"></span></label>'
    + '<input type="range" id="tc-dz" min="0" max="0.3" step="0.01">'
    + '<label><input type="checkbox" id="tc-steady-on" style="width:auto"> 开火稳枪启用</label>'
    + '<h4>手机触控 · 陀螺仪</h4>'
    + '<label><input type="checkbox" id="tc-gyro-on" style="width:auto"> 启用陀螺仪瞄准 (iOS 需授权)</label>'
    + '<label>陀螺仪灵敏度 <span id="tc-v-gs"></span></label>'
    + '<input type="range" id="tc-gs" min="0.2" max="4" step="0.1">'
    + '<div class="row">'
    + '<label style="flex:1"><input type="checkbox" id="tc-gix" style="width:auto"> 反转水平</label>'
    + '<label style="flex:1"><input type="checkbox" id="tc-giy" style="width:auto"> 反转垂直</label>'
    + '</div>'
    + '<div class="hint">进游戏后点 HUD 右上「陀螺」按钮授权/开关。方向若不对, 勾选反转。</div>'
    + '<h4>手机触控 · 高级</h4>'
    + '<label>渲染分辨率上限 dpr <span id="tc-v-dpr"></span></label>'
    + '<input type="range" id="tc-dpr" min="0.75" max="3" step="0.25">'
    + '<label>fps_max <span id="tc-v-fps"></span></label>'
    + '<input type="range" id="tc-fps" min="30" max="240" step="10">'
    + '<label>附加 cvar (每行一条, 进图后执行)</label>'
    + '<textarea id="tc-extra" rows="2" style="width:100%;box-sizing:border-box;background:#0b0e14;border:1px solid #2c3546;border-radius:6px;color:#e6e9ef;font-size:12px"></textarea>'
    + '<div class="row"><button id="tc-apply">应用性能设置</button></div>';

  function bindRange(id, key, fmt) {
    var el = document.getElementById(id); if (!el) return;
    var v = document.getElementById('tc-v-' + id.slice(5));
    function show() { if (v) v.textContent = fmt ? fmt(S[key]) : S[key]; }
    el.value = S[key]; show();
    el.addEventListener('input', function () { S[key] = +el.value; show(); saveS(); });
    el.addEventListener('change', function () { if (key === 'maxDpr' || key === 'fpsMax') applyPerf(); });
  }
  function bindSection(scope) {
    if (!scope || scope.__tcBound) return;
    scope.__tcBound = true;
    scope.insertAdjacentHTML('beforeend', SEC_HTML);
    bindRange('tc-sens', 'sens'); bindRange('tc-gamma', 'gamma');
    bindRange('tc-steady', 'fireSteady'); bindRange('tc-walk', 'walkTh');
    bindRange('tc-dz', 'deadzone'); bindRange('tc-gs', 'gyroSens');
    bindRange('tc-dpr', 'maxDpr'); bindRange('tc-fps', 'fpsMax');
    var so = document.getElementById('tc-steady-on'); if (so) { so.checked = !!S.fireSteadyOn; so.addEventListener('change', function () { S.fireSteadyOn = so.checked ? 1 : 0; saveS(); }); }
    var go = document.getElementById('tc-gyro-on'); if (go) { go.checked = !!S.gyroOn; go.addEventListener('change', function () { S.gyroOn = go.checked ? 1 : 0; saveS(); if (go.checked && !active) enableGyro(); }); }
    var gx = document.getElementById('tc-gix'); if (gx) { gx.checked = !!S.gyroInvertX; gx.addEventListener('change', function () { S.gyroInvertX = gx.checked ? 1 : 0; saveS(); }); }
    var gy = document.getElementById('tc-giy'); if (gy) { gy.checked = !!S.gyroInvertY; gy.addEventListener('change', function () { S.gyroInvertY = gy.checked ? 1 : 0; saveS(); }); }
    var ex = document.getElementById('tc-extra'); if (ex) { ex.value = S.extraCvars || ''; }
    var ap = document.getElementById('tc-apply');
    if (ap) ap.addEventListener('click', function () { if (ex) { S.extraCvars = ex.value; saveS(); } applyPerf(); });
    ['low', 'mid', 'high'].forEach(function (n) {
      var b = document.getElementById('tc-p-' + n);
      if (b) b.addEventListener('click', function () { applyPreset(n); if (ex) ex.value = S.extraCvars; });
    });
  }
  function ensurePanel() {
    // 优先注入 offline-enhance 的 #ocs-panel
    var p = document.getElementById('ocs-panel');
    if (p) { bindSection(p); return true; }
    // 独立兜底面板
    if (!document.getElementById('tc-panel')) {
      var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
      var btn = document.createElement('div');
      btn.style.cssText = 'position:fixed;right:14px;bottom:62px;z-index:2147483000;width:40px;height:40px;border-radius:50%;'
        + 'background:rgba(20,24,32,.72);border:1px solid rgba(255,255,255,.18);color:#7fd67f;font-size:18px;'
        + 'line-height:38px;text-align:center;cursor:pointer;user-select:none';
      btn.textContent = '✚'; btn.title = '触控设置';
      var pn = document.createElement('div');
      pn.id = 'tc-panel';
      pn.style.cssText = 'position:fixed;right:14px;bottom:110px;z-index:2147483000;width:340px;max-height:76vh;overflow:auto;'
        + 'background:rgba(16,19,26,.96);border:1px solid rgba(255,255,255,.14);border-radius:10px;color:#dfe3ea;'
        + 'font:13px/1.5 system-ui,Segoe UI,Microsoft YaHei,sans-serif;padding:14px 16px;display:none';
      btn.addEventListener('click', function () { pn.style.display = pn.style.display === 'none' ? 'block' : 'none'; });
      document.body.appendChild(btn); document.body.appendChild(pn);
      bindSection(pn);
    }
    return true;
  }

  // ============================================================
  // 9. 对外 API + 启动
  // ============================================================
  window.TouchCS = {
    settings: S,
    save: saveS,
    applyPerf: applyPerf,
    applyPreset: applyPreset,
    presets: PRESETS,
    enableGyro: enableGyro,
    disableGyro: disableGyro,
    run: tcRun,
    isActive: function () { return active; },
    version: '2.0.0'
  };

  document.addEventListener('devicemotion', onMotion, true);

  function boot() {
    bindTouch();
    var tries = 0;
    var t = setInterval(function () {
      if (ensurePanel()) clearInterval(t);
      if (++tries > 100) clearInterval(t);
    }, 100);
    console.log('[touch] touch-controls v2.0.0 loaded (激活条件: 首次触摸)');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
