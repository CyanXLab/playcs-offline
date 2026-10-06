# PlayCS Offline Mobile — 手机触屏版

> 位于 `mobile` 分支, 与 `main`(web/win 版)相互独立; 资源格式与服务器协议相同,
> 可与 PC 版互通同一本地服务器 / 中继。

## 组成

| 部分 | 说明 |
|---|---|
| `mobile-touch.js` | 触屏控制层(悬浮摇杆/按钮/陀螺仪/辅助/性能预设/防崩看门狗), 仅触屏设备激活 |
| `scripts/patch_mobile.py` | 把触屏层+PWA 注入 play.html(在 setup_download.py 之后执行) |
| `manifest.webmanifest` | PWA 全屏清单(横屏), 浏览器"添加到主屏幕"即全屏免地址栏 |
| `android/` | APK 工程: WebView 壳 + 内置本地服务器(COOP/COEP) + 资源下载器 + 崩溃自动恢复 |

## 网页版(手机浏览器/PWA)快速开始

在一台电脑上(与手机同局域网):

```bash
python3 setup_download.py .        # 下载资源(~2.2GB)
python3 scripts/patch_mobile.py .  # 注入触屏层
python3 playcs_server.py           # 启动服务器
# 手机浏览器打开 http://<电脑IP>:8000/
# (可选) 浏览器菜单 → 添加到主屏幕 → 从主屏幕打开即 PWA 全屏
```

## APK 快速开始

直接安装 Release 里的 `playcs-mobile-1.0.0.apk`。首次启动会自动下载
chunks 资源包(约 2.2GB, 断点续传, 建议在 Wi-Fi 下进行); 引擎文件已内置在 APK 中。

联机: 手机无需自己跑中继桥 —— 在游戏内 F8 设置里把中继指向局域网内
PC 的 `ws://<电脑IP>:8787`(PC 端运行 `playcs_server.py` 或 `PlayCS.exe --serve-only`)。

APK 自行构建: `cd android && gradle assembleRelease`(需要 Android SDK 34)。

## 触屏操作

- **左半屏任意位置按下** → 浮现虚拟摇杆; 轻推(内圈) = 静步(+speed), 推满 = 跑
- **右半屏滑动** = 视角; 双指在右半屏 = 同时开火不误触
- **按钮**: 开火(大)/跳/蹲(可切换 按住/锁定)/换弹/E 交互/1·2·3·Q 切枪/TAB 计分板/B 购买
- **右上角齿轮**: 灵敏度(横/纵)、手感曲线(线性/柔和/激进)、陀螺仪、辅助瞄准、性能预设

## 性能预设与防崩

- **DPR 渲染上限**(默认 2.0, 低配建议 1.5): 手动限制画布物理分辨率,
  避免 dpr=3 手机渲染量暴涨 9 倍 —— 这是"手机卡崩"的第一元凶
- 预设 cvar: fps_max / mat_picmip / r_decals / r_lod / r_dynamic / cl_detaildist 等
- JS 侧内存看门狗: 接近堆上限时横幅提醒, 可选自动重载(现场不丢, 引擎 IDBFS 保存配置)
- APK 侧: largeHeap、渲染进程崩溃自动重建、onTrimMemory 通知 JS 释放

## 如实说明(已知边界)

- 这是 WASM 版 Source 引擎, 不是原生手游; 预期中端机 30~50fps, 旗舰机 60fps,
  无法达到 COD 手游那种原生渲染的帧率与发热控制
- 移动为二值速度(引擎 cbuf 无模拟量入口), 靠静步内圈补偿手感
- 陀螺仪轴向映射与机型/持机方向有关, 如方向不对请在设置里换轴或用反相开关
- 准星辅助为像素颜色采样(实验性, 默认关), 对模型配色敏感
- 4GB 内存以下设备风险较高(base.data 解包 862MB); 建议 6GB+
