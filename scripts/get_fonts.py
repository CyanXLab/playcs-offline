#!/usr/bin/env python3
"""Download Google Fonts CSS + woff2 files for offline self-hosting."""
import re, subprocess, os

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
DEST = '/home/z/my-project/download/playcs-offline'
FONT_DIR = os.path.join(DEST, 'fonts')
CSS_URL = ('https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700'
           '&family=Noto+Sans+SC:wght@400;500;700&display=swap')

os.makedirs(FONT_DIR, exist_ok=True)

r = subprocess.run(['curl', '-sf', '--max-time', '30', '-A', UA, CSS_URL],
                   capture_output=True, text=True)
css = r.stdout
print('CSS fetched:', len(css), 'bytes')

# Extract woff2 URLs
urls = sorted(set(re.findall(r'url\((https://fonts\.gstatic\.com/[^)]+\.woff2)\)', css)))
print('font files:', len(urls))

mapping = {}
for i, u in enumerate(urls):
    fname = 'f%03d.woff2' % i
    out = os.path.join(FONT_DIR, fname)
    ok = subprocess.run(['curl', '-sf', '--retry', '3', '--max-time', '60', '-A', UA, u, '-o', out])
    if ok.returncode == 0:
        mapping[u] = 'fonts/' + fname
        print(f'[ok] {fname} <- {u.split("/")[-1]} ({os.path.getsize(out)} bytes)')
    else:
        print(f'[FAIL] {u}')

# Rewrite CSS to local paths
for u, local in mapping.items():
    css = css.replace(u, local)

with open(os.path.join(DEST, 'fonts', 'fonts.css'), 'w') as f:
    f.write(css)
print('\nfonts.css written, entries replaced:', len(mapping))
