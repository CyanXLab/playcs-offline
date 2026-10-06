#!/usr/bin/env python3
"""Download all engine dylib (.so) files via GET (HEAD is blocked on CDN)."""
import re, subprocess, os, shutil

UA = 'Mozilla/5.0'
CDN = 'https://file.playcs.cc'
DEST = '/home/z/my-project/download/playcs-offline'

names = set()
wasm = open(f'{DEST}/play.wasm', 'rb').read().decode('utf-8', 'replace')
names.update(re.findall(r'lib[\w]+\.so\b', wasm))
js = open(f'{DEST}/play.js', encoding='utf-8', errors='replace').read()
names.update(re.findall(r'lib[\w]+\.so\b', js))
names = sorted(names)
print('candidate dylibs:', len(names))

ok, fail = 0, 0
for n in names:
    out = os.path.join(DEST, n)
    if os.path.exists(out) and os.path.getsize(out) > 1000:
        print(f'[skip] {n} ({os.path.getsize(out)//1024}KB)')
        ok += 1
        continue
    part = out + '.part'
    r = subprocess.run(['curl', '-sf', '--retry', '4', '--retry-delay', '2',
                        '--max-time', '3600', '-A', UA, f'{CDN}/{n}', '-o', part])
    if r.returncode == 0 and os.path.exists(part) and os.path.getsize(part) > 1000:
        shutil.move(part, out)
        print(f'[ok]   {n} ({os.path.getsize(out)//1024//1024 or os.path.getsize(out)//1024}K)')
        ok += 1
    else:
        print(f'[FAIL] {n} rc={r.returncode}')
        fail += 1

print(f'\nDONE ok={ok} fail={fail}')
