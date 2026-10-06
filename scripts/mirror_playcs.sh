#!/usr/bin/env bash
# Mirror playcs.cc to local offline copy
# Origin: https://playcs.cc (lobby site)  CDN: https://file.playcs.cc (game engine files)
set -u
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
DEST="${DEST:-$PWD/playcs-offline}"
ORIGIN="https://playcs.cc"
CDN="https://file.playcs.cc"
LOG="/home/z/my-project/mirror.log"

mkdir -p "$DEST"

fetch() { # fetch <url> <dest-relative-path>   (temp file + resume + size check)
  local url="$1" rel="$2"
  local out="$DEST/$rel"
  local part="$out.part"
  if [ -s "$out" ]; then
    echo "[skip] $rel" | tee -a "$LOG"; return 0
  fi
  mkdir -p "$(dirname "$out")"
  # expected size from server
  local expect
  expect=$(curl -sI --max-time 20 -A "$UA" "$url" | tr -d '\r' | awk 'tolower($1)=="content-length:"{s=$2} END{print s}')
  # resume partial download if present
  local resume=""
  [ -s "$part" ] && resume="-C -"
  if curl -sf $resume --retry 4 --retry-delay 2 --max-time 7200 -A "$UA" "$url" -o "$part"; then
    local got=$(stat -c%s "$part")
    if [ -n "$expect" ] && [ "$got" != "$expect" ]; then
      echo "[SIZE-MISMATCH] $rel got=$got expect=$expect (retry later)" | tee -a "$LOG"; return 1
    fi
    mv -f "$part" "$out"
    echo "[ok]   $rel ($(numfmt --to=iec $got))" | tee -a "$LOG"
  else
    echo "[FAIL] $url (have $(stat -c%s "$part" 2>/dev/null || echo 0) bytes cached)" | tee -a "$LOG"; return 1
  fi
}

# ---------- 1. Core pages ----------
fetch "$ORIGIN/"                       "index.html"
fetch "$ORIGIN/play.html"             "play.html"

# ---------- 2. Lobby assets ----------
fetch "$ORIGIN/assets/app.js"         "assets/app.js"
fetch "$ORIGIN/assets/lobby.css"      "assets/lobby.css"
for f in hideandseek/hideandseek.css hideandseek/like.svg hideandseek/lock.svg hideandseek/star.svg \
         killcards.css savior/savior.css sb/avatar-ct.png sb/avatar-terrorist.png dead.svg \
         scoreboard.css winpanel.css; do
  fetch "$ORIGIN/assets/hud/$f" "assets/hud/$f"
done

# ---------- 3. three.js ----------
fetch "$ORIGIN/vendor/three/three.module.min.js" "vendor/three/three.module.min.js"
fetch "$ORIGIN/vendor/three/addons/loaders/GLTFLoader.js" "vendor/three/addons/loaders/GLTFLoader.js"

# ---------- 4. icons / images / media / models / data ----------
for f in icon-32.png icon-128.png icon-512.png; do
  fetch "$ORIGIN/$f" "$f"
done
for f in cs_office de_aztec de_dust2 de_mirage de_train dz_blacksite; do
  fetch "$ORIGIN/images/icon/map_icon_$f.png" "images/icon/map_icon_$f.png"
done
for f in aztec blacksite dust2 mirage office train; do
  fetch "$ORIGIN/media/$f.webm" "media/$f.webm"
done
for f in alchemy-fail alchemy-process alchemy-success openresult opensound; do
  fetch "$ORIGIN/media/$f.mp3" "media/$f.mp3"
done
for f in ct_gign ct_gsg9 ct_sas ct_urban t_arctic t_guerilla t_leet t_phoenix; do
  fetch "$ORIGIN/model/$f.glb" "model/$f.glb"
done
fetch "$ORIGIN/data/achievements-i18n.json" "data/achievements-i18n.json"

# ---------- 5. profile rank images 1..40 (both path variants) ----------
for i in $(seq 1 40); do
  fetch "$ORIGIN/lobby/images/profile_rank/$i.png" "lobby/images/profile_rank/$i.png"
done
for i in $(seq 1 40); do
  fetch "$ORIGIN/images/profile_rank/$i.png" "images/profile_rank/$i.png"
done

# ---------- 6. Game engine + core chunks from CDN ----------
fetch "$CDN/play.wasm" "play.wasm"
for f in base hud savior zemod hideandseek weapon_skins patch1 patch2 patch3 patch4 patch5 patch6 de_dust2; do
  fetch "$CDN/chunks/$f.data" "chunks/$f.data"
done
fetch "$CDN/chunks/uncompressed-bytes.json" "chunks/uncompressed-bytes.json"

# ---------- 7. Extra map chunks from CDN ----------
for m in cs_assault cs_italy cs_office de_aztec de_cbble de_dust de_inferno de_nuke de_train; do
  fetch "$CDN/chunks/$m.data" "chunks/$m.data"
done

echo "=== MIRROR DONE ===" | tee -a "$LOG"
du -sh "$DEST"
