#!/usr/bin/env python3
"""冒烟测试: 本地服务器 + play.html + offline-enhance.js 补丁生效验证"""
import json
import subprocess
import sys
import threading
import time
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'playcs-offline'))
os_dir = '/home/z/my-project/download/playcs-offline'

import os
os.chdir(os_dir)
from playcs_server import StaticHandler
from http.server import ThreadingHTTPServer

srv = ThreadingHTTPServer(('127.0.0.1', 18088), StaticHandler)
srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()
time.sleep(0.3)

# 确认 play.html 有补丁引用
html = urllib.request.urlopen('http://127.0.0.1:18088/play.html').read().decode()
assert 'offline-enhance.js' in html, 'play.html missing patch script'
assert 'googletagmanager' not in html, 'gtag still present'
print('play.html patch reference: OK')

from playwright.sync_api import sync_playwright

logs = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page()
    page.on('console', lambda m: logs.append((m.type, m.text)))
    page.on('pageerror', lambda e: logs.append(('pageerror', str(e))))
    # 直接访问 play.html(带 map 参数, 走完整 chunk preload —— 但只验证前 15 秒的补丁与网络行为)
    try:
        page.goto('http://127.0.0.1:18088/play.html?map=de_dust2&skins=0', timeout=20000)
    except Exception as e:
        print('goto timeout (正常, 引擎在长加载):', str(e)[:80])
    time.sleep(12)
    browser.close()

srv.shutdown()

patched = any('downloadMap patched' in t for _, t in logs)
enhance = any('enhance patch' in t for _, t in logs)
relay = any('wsProxyUrl' in t or 'relay' in t.lower() for _, t in logs)
errors = [t for k, t in logs if k in ('error', 'pageerror') and 'favicon' not in t and '404' not in t]
print('--- console (关键) ---')
for k, t in logs:
    if any(x in t for x in ('offline', 'downloadMap', 'wsProxy', 'Chunk', 'chunk', 'error', 'Error')):
        print(f'[{k}] {t[:160]}')
print('--- 结论 ---')
print('enhance.js loaded:', enhance)
print('downloadMap patched:', patched)
print('JS errors:', len(errors))
for e in errors[:5]:
    print('  ERR:', e[:160])
sys.exit(0 if (enhance and patched and not errors) else 1)
