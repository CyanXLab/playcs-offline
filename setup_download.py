#!/usr/bin/env python3
"""
PLAYCS 离线版 - 游戏资源一键下载器 (setup_download.py)
========================================================
适用于: 从 GitHub 仓库 clone 本项目后, 一次性拉取全部游戏资源(~2.2GB)。
资源来自 playcs.cc 官方公共 CDN(file.playcs.cc), 支持断点续传。

用法:
    python3 setup_download.py              # 下载到当前目录
    python3 setup_download.py 目标目录      # 指定目录
    python3 setup_download.py --verify     # 只校验已下载文件完整性
"""
import os
import sys
import json
import time
import urllib.request

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      'Chrome/120.0.0.0 Safari/537.36')
ORIGIN = 'https://playcs.cc'
CDN = 'https://file.playcs.cc'

# ---------------------------------------------------------------- 资源清单
# (url, 相对路径)
FILES = []


def add(url, rel):
    FILES.append((url, rel))


# 核心页面与引擎
add(f'{ORIGIN}/', 'index.html')
add(f'{ORIGIN}/play.html', 'play.html')
add(f'{ORIGIN}/play.js', 'play.js')
add(f'{CDN}/play.wasm', 'play.wasm')

# 大厅资产
add(f'{ORIGIN}/assets/app.js', 'assets/app.js')
add(f'{ORIGIN}/assets/lobby.css', 'assets/lobby.css')
for f in ('hideandseek/hideandseek.css', 'hideandseek/like.svg', 'hideandseek/lock.svg',
          'hideandseek/star.svg', 'killcards.css', 'savior/savior.css',
          'sb/avatar-ct.png', 'sb/avatar-terrorist.png', 'dead.svg',
          'scoreboard.css', 'winpanel.css'):
    add(f'{ORIGIN}/assets/hud/{f}', f'assets/hud/{f}')

# three.js
add(f'{ORIGIN}/vendor/three/three.module.min.js', 'vendor/three/three.module.min.js')
add(f'{ORIGIN}/vendor/three/addons/loaders/GLTFLoader.js', 'vendor/three/addons/loaders/GLTFLoader.js')
add(f'{ORIGIN}/vendor/three/addons/utils/BufferGeometryUtils.js', 'vendor/three/addons/utils/BufferGeometryUtils.js')

# 图标 / 图片 / 媒体 / 模型 / 数据
for f in ('icon-32.png', 'icon-128.png', 'icon-512.png'):
    add(f'{ORIGIN}/{f}', f)
for f in ('cs_office', 'de_aztec', 'de_dust2', 'de_mirage', 'de_train', 'dz_blacksite'):
    add(f'{ORIGIN}/images/icon/map_icon_{f}.png', f'images/icon/map_icon_{f}.png')
for f in ('aztec', 'blacksite', 'dust2', 'mirage', 'office', 'train'):
    add(f'{ORIGIN}/media/{f}.webm', f'media/{f}.webm')
for f in ('alchemy-fail', 'alchemy-process', 'alchemy-success', 'openresult', 'opensound'):
    add(f'{ORIGIN}/media/{f}.mp3', f'media/{f}.mp3')  # 原站部分 404, 下载失败自动跳过
for f in ('ct_gign', 'ct_gsg9', 'ct_sas', 'ct_urban', 't_arctic', 't_guerilla', 't_leet', 't_phoenix'):
    add(f'{ORIGIN}/model/{f}.glb', f'model/{f}.glb')
add(f'{ORIGIN}/data/achievements-i18n.json', 'data/achievements-i18n.json')
for i in range(1, 41):
    add(f'{ORIGIN}/lobby/images/profile_rank/{i}.png', f'lobby/images/profile_rank/{i}.png')
    add(f'{ORIGIN}/images/profile_rank/{i}.png', f'images/profile_rank/{i}.png')

# 动态库(play.wasm 加载的 lib*.so)
DYLIBS = """libGameUI.so libServerBrowser.so libclient.so libdatacache.so libengine.so
libfilesystem_stdio.so libinputsystem.so liblauncher.so libmaterialsystem.so
libscenefilecache.so libserver.so libshaderapidx9.so libsoundemittersystem.so
libstdshader_dx9.so libsteam_api.so libstudiorender.so libtogl.so libvaudio_minimp3.so
libvgui2.so libvguimatsurface.so libvideo_services.so libvphysics.so libvstdlib.so
libvtex_dll.so libvscript.so libschemadll.so libanimationsystem.so liblocalize.so""".split()
for name in DYLIBS:
    add(f'{CDN}/{name}', name)

# 分包(chunks)
CHUNKS = ['base', 'weapon_skins', 'savior', 'zemod', 'hideandseek', 'hud',
          'patch1', 'patch2', 'patch3', 'patch4', 'patch5', 'patch6',
          'de_dust2', 'de_dust', 'de_inferno', 'de_nuke', 'de_aztec',
          'de_cbble', 'de_train', 'cs_office', 'cs_italy', 'cs_assault']
for c in CHUNKS:
    add(f'{CDN}/chunks/{c}.data', f'chunks/{c}.data')

# 字体(自托管清单)
add(f'{ORIGIN}/fonts/fonts.css', 'fonts/fonts.css')


def fetch(url, rel, dest):
    out = os.path.join(dest, rel)
    part = out + '.part'
    if os.path.exists(out) and os.path.getsize(out) > 0:
        return 'skip'
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    # HEAD 拿大小(CDN 对部分路径禁 HEAD, 失败则容忍)
    expect = None
    try:
        req = urllib.request.Request(url, method='HEAD', headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            expect = int(r.headers.get('Content-Length') or 0) or None
    except Exception:
        expect = None
    headers = {'User-Agent': UA}
    if os.path.exists(part) and os.path.getsize(part) > 0:
        headers['Range'] = f'bytes={os.path.getsize(part)}-'
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=7200) as r:
            total = int(r.headers.get('Content-Length') or 0) or expect or 0
            mode = 'ab' if (r.status == 206 and os.path.exists(part)) else 'wb'
            got = os.path.getsize(part) if mode == 'ab' else 0
            start_t = time.time()
            with open(part, mode) as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    got += len(chunk)
                    if total:
                        pct = got * 100 // total
                        speed = got / max(1e-6, time.time() - start_t) / 1e6
                        sys.stdout.write(f'\r  {rel}: {pct:3d}% ({got/1e6:.0f}/{total/1e6:.0f} MB, {speed:.1f} MB/s)')
                        sys.stdout.flush()
        print()
        if expect and os.path.getsize(part) != expect:
            return f'size mismatch ({os.path.getsize(part)} != {expect})'
        os.replace(part, out)
        return 'ok'
    except Exception as e:
        return f'fail: {e}'


def main():
    dest = '.'
    verify = False
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    if args:
        dest = args[0]
    verify = '--verify' in sys.argv
    os.makedirs(dest, exist_ok=True)

    if verify:
        bad = []
        for url, rel in FILES:
            out = os.path.join(dest, rel)
            if not os.path.exists(out) or os.path.getsize(out) == 0:
                bad.append(rel)
        print('缺失/空文件:', len(bad))
        for b in bad:
            print('  -', b)
        return

    print(f'PLAYCS 离线版资源下载器 → {os.path.abspath(dest)}')
    print(f'共 {len(FILES)} 个文件, 约 2.2 GB (已存在的自动跳过)\n')
    fails = []
    for i, (url, rel) in enumerate(FILES, 1):
        print(f'[{i}/{len(FILES)}] {rel}')
        for attempt in range(3):
            r = fetch(url, rel, dest)
            if r in ('ok', 'skip'):
                break
            print(f'  重试 {attempt + 1}: {r}')
            time.sleep(2)
        else:
            fails.append((rel, r))
    print('\n========== 完成 ==========')
    if fails:
        print('失败列表(多为原站本就不存在的文件, 可忽略):')
        for rel, why in fails:
            print(f'  {rel}: {why}')
    print('\n下一步:')
    print('  python3 playcs_server.py      # 启动本地服务器')
    print('  打开 http://localhost:8000/')


if __name__ == '__main__':
    main()
