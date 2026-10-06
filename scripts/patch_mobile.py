#!/usr/bin/env python3
"""
Patch the mirrored play.html for MOBILE (touch) play:
1. viewport meta (禁缩放, 铺满安全区)
2. PWA 全屏 manifest + 主题色 + mobile-web-app-capable
3. 注入 mobile-touch.js (触屏控制层, 仅触屏设备激活)
用法: 在 setup_download.py 下载资源后执行:  python3 scripts/patch_mobile.py [目录]
"""
import re, sys, os

DEST = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..')
p = os.path.join(DEST, 'play.html')
html = open(p, encoding='utf-8').read()
orig = html

# ---------- 1. viewport ----------
if 'name="viewport"' not in html:
    html = re.sub(r'(<head[^>]*>)',
                  r'\1\n<meta name="viewport" content="width=device-width, initial-scale=1, '
                  r'maximum-scale=1, user-scalable=no, viewport-fit=cover">',
                  html, count=1)

# ---------- 2. PWA ----------
if 'manifest.webmanifest' not in html:
    html = re.sub(r'(<head[^>]*>)',
                  r'\1\n<link rel="manifest" href="manifest.webmanifest">'
                  '<meta name="theme-color" content="#0b0e14">'
                  '<meta name="mobile-web-app-capable" content="yes">'
                  '<meta name="apple-mobile-web-app-capable" content="yes">'
                  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
                  html, count=1)

# ---------- 3. mobile-touch.js (必须在 play.js 之后) ----------
if 'mobile-touch.js' not in html:
    inject = '<script src="mobile-touch.js"></script>\n'
    new_html, n = re.subn(r'(<script[^>]*src="play\.js[^"]*"[^>]*>\s*</script>)',
                          r'\1\n' + inject, html, count=1)
    if n == 0:
        new_html, n = re.subn(r'(<script[^>]*src="play\.js[^"]*")',
                              r'\1' + '></script>\n' + inject + '<script async src="',
                              html, count=1)
    if n == 0:
        new_html = html.replace('</body>', inject + '</body>')
    html = new_html

if html != orig:
    open(p, 'w', encoding='utf-8').write(html)
    print('play.html patched for mobile: viewport + PWA manifest + mobile-touch.js')
else:
    print('play.html already mobile-patched')

# ---------- verify ----------
h = open(p, encoding='utf-8').read()
for k in ('name="viewport"', 'manifest.webmanifest', 'mobile-touch.js'):
    print(' verify', k, ':', k in h)
