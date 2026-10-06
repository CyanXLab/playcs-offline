#!/usr/bin/env python3
"""
Patch the mirrored playcs.cc files for offline single-origin serving:
1. play.html : inject window.GAME_ASSET_CDN = location.origin  (engine assets from local server)
2. index.html: replace Google Fonts links with local fonts/fonts.css
"""
import re, sys

DEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'playcs-offline')

# ---------- 1. play.html ----------
p = f'{DEST}/play.html'
html = open(p, encoding='utf-8').read()

if 'GAME_ASSET_CDN=location.origin' not in html and 'GAME_ASSET_CDN = location.origin' not in html:
    inject = ('<script>'
              'window.GAME_ASSET_CDN = location.origin;'   # all engine files from local origin
              'window.GAME_PURE_WEB_ONLY = true;'          # pure-web path
              '</script>\n')
    # inject before the play.js script tag
    new_html, n = re.subn(r'(<script src="play\.js)', inject + r'\1', html, count=1)
    if n == 0:
        # fallback: inject as early as possible after <head>
        new_html, n = re.subn(r'(<head[^>]*>)', r'\1\n' + inject, html, count=1)
    assert n == 1, 'could not find injection point in play.html'
    open(p, 'w', encoding='utf-8').write(new_html)
    print('play.html patched: GAME_ASSET_CDN -> location.origin')
else:
    print('play.html already patched')

# ---------- 2. index.html ----------
p = f'{DEST}/index.html'
html = open(p, encoding='utf-8').read()
orig = html

# remove preconnect links to google fonts
html = re.sub(r'<link rel="preconnect" href="https://fonts\.googleapis\.com">\s*', '', html)
html = re.sub(r'<link rel="preconnect" href="https://fonts\.gstatic\.com"[^>]*>\s*', '', html)
# replace stylesheet link with local fonts.css
html = re.sub(
    r'<link href="https://fonts\.googleapis\.com/css2[^"]*" rel="stylesheet">',
    '<link href="fonts/fonts.css" rel="stylesheet">',
    html)
if html != orig:
    open(p, 'w', encoding='utf-8').write(html)
    print('index.html patched: Google Fonts -> fonts/fonts.css')
else:
    print('index.html: no font links changed (check manually)')

# ---------- 3. verify ----------
h = open(f'{DEST}/play.html', encoding='utf-8').read()
ok1 = 'GAME_ASSET_CDN' in h
print('verify play.html GAME_ASSET_CDN:', ok1)
i = open(f'{DEST}/index.html', encoding='utf-8').read()
print('verify index.html fonts.googleapis remains:', 'fonts.googleapis.com' in i)
