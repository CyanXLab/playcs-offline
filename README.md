# PlayCS Offline — CS:S 网页版完整离线方案

把 [playcs.cc](https://playcs.cc)(浏览器版 Counter-Strike: Source)完整搬到本地运行的
离线化项目。包含:游戏资源镜像、本地服务器(账号 API 模拟 + 联机中继网关)、
**游戏内换图 bug 修复**、**离线改名**、**自建中继**、**Windows 一键启动包**。

> ⚠️ 本项目仅用于个人学习研究。游戏引擎与全部资源的版权归 playcs.cc 作者所有,
> 请勿用于商业用途或公开分发资源文件。

---

## 目录

- [快速开始](#快速开始)
- [Windows 一键启动包(推荐)](#windows-一键启动包推荐)
- [源码方式运行(Python)](#源码方式运行python)
- [修复了什么:游戏内换图 bug](#修复了什么游戏内换图-bug)
- [离线功能说明(改名等)](#离线功能说明改名等)
- [联机与自建中继](#联机与自建中继)
- [设置面板(F8)](#设置面板f8)
- [项目结构](#项目结构)
- [架构说明(逆向结论)](#架构说明逆向结论)
- [FAQ](#faq)

---

## 快速开始

```bash
# 1. 下载游戏资源(~2.2GB, 一次性, 自动断点续传)
python3 setup_download.py .

# 2. 启动本地服务器
python3 playcs_server.py

# 3. 打开浏览器
#    http://localhost:8787/
```

就这么简单 —— 单端口 8787 同时提供 **静态页面 + 账号 API + 联机中继**。

## Windows 一键启动包(推荐)

到 [Releases](../../releases) 下载两个压缩包,**解压到同一个文件夹**:

```
PlayCS-Offline-v1.0.0-part1-of2.zip        # 程序 + 引擎 + 大部分资源
PlayCS-Offline-v1.0.0-part2-base.data.zip  # base.data(862MB 主资源包)
```

解压后双击 **`PlayCS.exe`** —— 立即进入游戏,零配置。

- 自动选择端口启动内置服务(默认 8787,被占用自动顺延)
- 独立窗口运行,**拦截了浏览器快捷键**(Ctrl+W/T/N/Q/L…),游戏时不再误触
- 性能优化:关闭帧率上限 / 垂直同步、后台不降频、GPU 高性能模式
- 无需 Python —— 服务器/中继/API 全部内置在 Electron 主进程里

高级启动参数:

```
PlayCS.exe --kiosk          # 开机全屏(街机模式)
PlayCS.exe --serve-only     # 只启动服务不开窗口(给局域网朋友当中继/服务器)
PlayCS.exe --port 9000      # 指定端口
```

## 源码方式运行(Python)

```bash
python3 setup_download.py .     # 首次: 下载游戏资源
python3 playcs_server.py        # 启动: 静态 + API + 中继 (单端口 8787)
```

- `http://localhost:8787/` — 游戏大厅(单端口全功能: 静态 + 账号 API + 中继)
- 局域网其他设备: `http://<你的IP>:8787/`

> **v1.0.1 更新**: 端口统一为 8787(不再用 8000) · 本地账号免邮箱验证码 ·
> 自动同步 playcs.cc 官方服务器列表 · Windows 双显卡自动强制独显 · 服务器日志写入 `playcs_data/server.log`

## 修复了什么:游戏内换图 bug

**现象**(原版离线补丁):直接进地图正常;但进入游戏后换图,
机器人不加、自动重进一次、全屏紫黑棋盘格。

**根因**(逆向 play.js + libengine.so 得出):

1. 引擎运行时发现缺地图文件时,通过 Emscripten 的 callHandler 调用
   `Module.downloadMap(lock, mapName)`,然后等待 `Atomics` 解锁;
2. play.js 的实现把它交给 `dataLoader.downloadMapSync()`;
3. 而这个函数在纯 Web 模式(`GAME_PURE_WEB_ONLY=true`)下**直接解锁、不加载任何资源** ——
   引擎只等到了"无事发生",于是加载失败→重试→材质全缺。

**修复**(见 [`offline-enhance.js`](offline-enhance.js)):覆盖 `Module.downloadMap`,
把地图名映射到 `chunks/<地图>.data`,调用 play.js 自带的公开 API
`window.loadGameDataChunk()` 下载解包挂载到 Emscripten 文件系统,
完成后 `Atomics.store + notify` 解锁引擎。加载走官方 UI 进度条,可反复换图。

## 离线功能说明(改名等)

原站的"改名卡"等属于**在线库存系统**功能。离线版的替代方案:

| 在线功能 | 离线版对应 |
|---|---|
| 改名卡 | **设置面板(F8)直接改昵称**,即引擎 `name` convar,立即生效,保存于 localStorage |
| 账号注册/登录 | 本地服务器内置账号系统(PBKDF2 加盐哈希,存 `playcs_data/accounts.json`) |
| 成就 | 本地存档(`playcs_data/achievements_local.json`),API 同步接口已模拟 |
| 皮肤/武器箱/炼金 | 本地无数据,优雅降级;引擎皮肤包 `weapon_skins.data` 离线可用 |
| 战绩/排行榜 | 空数据占位 |
| 服务器列表 | 见下文「联机与自建中继」 |

改名原理:`play.js` 暴露了 `window.engineRunCommand()`,内部即引擎命令缓冲区注入
(`_emscripten_Cbuf_AddText`),因此 `'name "昵称"'` 无需任何在线 API。

## 联机与自建中继

### 联机原理(逆向结论)

```
引擎 socket(connect 目标:端口)
   → libengine.so 内的 WebSocket 桥(读取 Module.wsProxyUrl 作为网关基址)
   → WebSocket 连接: <基址>/<目标addr>:<端口>   (子协议 binary, 帧=UDP载荷)
   → 网关建立到目标的真实 UDP/TCP 通道, 双向透传
```

- 官方网关默认值(写死在 libengine.so):`wss://css.yikm.net/websocket/u/...`
- 引擎侧优先级:`Module.wsProxyUrl` → `globalThis.__SOURCE_WS_PROXY_URL__` → 官方默认
- DGRAM 首帧 `FF FF FF FF 'p' 'o' 'r' 't' hi lo` 是引擎源端口宣告,中继无需处理

### 三种中继选择(设置面板 F8)

| 选项 | 地址 | 说明 |
|---|---|---|
| **本地默认** | `ws://<当前主机>:<端口>/websocket/u` | 随本地服务器/Electron 内置,零配置 |
| **官方网关** | `wss://css.yikm.net/websocket/u` | playcs.cc 官方,联官方服需联网 |
| **自定义** | 任意 `ws(s)://...` | 你自己部署的中继(下述) |

### 自建中继(两行配置)

本仓库的中继就是**一个无依赖模块**,官方网关做什么它就做什么:

```python
# 方式一: 直接用本项目的服务器(内置中继)
python3 playcs_server.py 8787
# 中继地址: ws://<你的IP>:8787/websocket/u/<目标IP>:<端口>
```

```js
// 方式二: Electron 版当常驻中继
PlayCS.exe --serve-only --port 8787
```

把 `ws://<你的IP>:<端口>/websocket/u` 填进设置面板(F8)即可。
路由约定:`/websocket/u/<host>:<port>` = UDP 桥,`/websocket/t/<host>:<port>` = TCP 桥。

### 能连谁?

- ✅ **局域网里任何人开的真实 CS:S 服务器**(标准 Source 服务端,UDP 27015)
- ✅ **公网服务器**(填 IP:端口即可,中继做 WS↔UDP 桥)
- ✅ **官方服务器**(中继选"官方网关"并填官方服地址)
- ⚠️ 引擎与服务器需协议版本兼容(同版 CS:S);中继只做透明传输

服务器列表支持两种添加方式:
1. 设置面板(F8)"游戏服务器 · 快速连接"
2. 编辑 `offline-servers.json`(本地服务器会通过 `/api/servers/` 下发给大厅)

## 设置面板(F8)

游戏页与大厅页右下角齿轮 / 按 F8 呼出:

- **玩家昵称**:即改即生效,离线可用
- **联机中继网关**:官方 / 本地默认 / 自定义
- **快速连接服务器**:保存常用 `IP:端口` + 地图,一键进入
  (`play.html?connect=<addr>&ws=<relay>&map=<map>`)

## 项目结构

```
playcs-offline/
├── index.html / play.html     原站页面(已打离线补丁)
├── play.js / play.wasm        Emscripten 运行时 + Source 引擎
├── *.so                       引擎动态库
├── chunks/*.data              资源分包(~2.2GB, setup_download.py 下载)
├── playcs_server.py           本地服务器: 静态+API+账号(纯标准库)
├── ws_relay.py                WS↔UDP/TCP 联机中继(纯标准库)
├── offline-enhance.js         核心补丁: 换图修复/改名/中继设置/快速连接
├── setup_download.py          资源一键下载器
├── offline-servers.json       服务器列表配置
├── electron/                  Windows 打包主进程(零 npm 依赖)
│   ├── main.js                HTTP静态+API+中继+窗口+快捷键拦截+性能
│   └── package.json
└── 启动离线版.bat             Windows Python 备用启动脚本
```

## 架构说明(逆向结论)

```
┌────────────────────────── 浏览器/Electron 窗口 ──────────────────────────┐
│  index.html (大厅, 原生JS + Three.js)                                    │
│      │  ?serverId= / ?connect= / ?map= / ?ws=                            │
│      ▼                                                                   │
│  play.html (Emscripten 启动页)                                           │
│      ├─ play.js (871KB): 运行时+胶水, SDL2, SOCKFS, chunk 分包加载,       │
│      │   账号 token, config.cfg (base64+IDBFS/LocalStorage 持久化)        │
│      ├─ play.wasm (4.2MB) + 25 个 lib*.so                                │
│      └─ offline-enhance.js  ← 本项目核心补丁                              │
└──────────────┬──────────────────────────────┬────────────────────────────┘
               │ HTTP(chunks/api)              │ WebSocket(联机)
               ▼                               ▼
   本地服务器(静态+API+中继)          中继网关 → 真实 CS:S 服务器(UDP)
```

关键机制:

| 机制 | 说明 |
|---|---|
| 资源分包 | `chunks/*.data` 由 play.js 预载并解包进 Emscripten FS;游戏内缺文件走 `Module.downloadMap`(已修复) |
| 本地 API 后门 | play.js 检测 `localhost` 时 API 自动指向 `localhost:8787`;本项目单端口方案直接接管 |
| 账号会话 | `localStorage["lobby.auth.session.v1"]` + `_emscripten_SetAccountSession` |
| 配置持久化 | `config.cfg` base64 存储,经 IDBFS/LocalStorage 往返 |
| 并发隔离 | 引擎使用 SharedArrayBuffer,本地服务器必须带 COOP/COEP 响应头 |

## FAQ

**Q: 首次加载很慢?**
A: 引擎要解包 862MB 的 base.data 并预热缓存,原站一样慢;第二次起会快很多。

**Q: 换图后还是紫黑?**
A: 检查 `chunks/` 下是否有对应地图包;按 F12 看 `[offline] downloadMap` 日志。
   没有 chunk 的地图需要先下载对应包(或用 `setup_download.py --verify` 检查)。

**Q: 联机时怎么确认中继在工作?**
A: 服务器控制台(或 Electron 的 stdout)会打印 `[relay] UDP bridge → <目标>`,
   每来一个连接打一条。

**Q: 我想给朋友局域网玩?**
A: 一台机器跑 `PlayCS.exe --serve-only` 或 `playcs_server.py` 当服务器/中继,
   大家浏览器打开 `http://服务器IP:8787/`,设置里中继选"本地默认",
   服务器地址填运行真实 CS:S 服务端那台机器的 `IP:27015`。

**Q: Windows 包为什么分两个压缩包?**
A: base.data 862MB 太大,GitHub Release 单文件上限 2GB;两个包解压到同一目录即合并。
