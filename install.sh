#!/usr/bin/env bash
# Instalador del CRM Activemur (offline: los ficheros vienen en payload/).
# Uso dentro del contenedor:  bash install.sh
# Variables: CRM_DIR (def. /config/workspace/crm), CRM_PORT (def. 8090)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$HERE/payload"
DEST="${CRM_DIR:-/config/workspace/crm}"
PORT="${CRM_PORT:-8090}"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "== Activemur CRM · actualización $STAMP =="
[ -f "$DEST/server.js" ] || { echo "ERROR: no existe $DEST/server.js (¿CRM_DIR correcto?)"; exit 1; }
[ -d "$PAYLOAD" ] || { echo "ERROR: falta $PAYLOAD"; exit 1; }

echo "1/6 copia de seguridad"
cp -a "$DEST" "$DEST.bak-$STAMP"
echo "   $DEST.bak-$STAMP"

echo "2/6 copia de ficheros"
for f in db.js server.js test.js cdp-ui-test.js; do cp "$PAYLOAD/$f" "$DEST/$f"; done
for f in track.js app.js index.html styles.css; do cp "$PAYLOAD/public/$f" "$DEST/public/$f"; done
if [ -f "$HERE/metrics.env" ] && ! grep -q '^CRM_METRICS_TOKEN=' "$DEST/.env" 2>/dev/null; then
  cat "$HERE/metrics.env" >> "$DEST/.env"
  echo "   token de métricas añadido al .env"
fi

echo "3/6 comprobación de sintaxis"
cd "$DEST"
node --check server.js
node --check db.js
node --check public/app.js
grep -q "api/public/lead" server.js || { echo "ERROR: server.js no trae el endpoint público"; exit 1; }
grep -q "av_vid" public/track.js || { echo "ERROR: track.js no es el nuevo"; exit 1; }

echo "4/6 reinicio del proceso"
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" 2>/dev/null || true
elif command -v lsof >/dev/null 2>&1; then
  kill $(lsof -t -i:"$PORT") 2>/dev/null || true
elif [ -f "$DEST/.pid" ]; then
  kill "$(cat "$DEST/.pid")" 2>/dev/null || true
fi
sleep 2
if [ -x /config/custom-cont-init.d/40-start-crm ]; then
  bash /config/custom-cont-init.d/40-start-crm || true
else
  set -a; . "$DEST/.env"; set +a
  export CRM_PORT="$PORT"
  nohup node server.js >> server.log 2>&1 &
  echo $! > .pid
fi
sleep 3

echo "5/6 verificación"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/me" || echo 000)
TRACK=$(curl -s "http://127.0.0.1:$PORT/track.js" | grep -c av_vid || true)
TOKEN=$(grep '^CRM_METRICS_TOKEN=' "$DEST/.env" 2>/dev/null | cut -d= -f2 || true)
METRICS=$(curl -s -o /dev/null -w '%{http_code}' -H "x-metrics-token: $TOKEN" "http://127.0.0.1:$PORT/api/metrics" || echo 000)
echo "   /api/me -> $CODE (esperado 401)"
echo "   track.js av_vid -> $TRACK (esperado 1)"
echo "   /api/metrics -> $METRICS (esperado 200)"

if [ "$CODE" = "401" ] && [ "$TRACK" -ge 1 ] && [ "$METRICS" = "200" ]; then
  echo "6/6 OK. Abre https://crm.161-97-123-197.sslip.io y entra en 'Tráfico'."
else
  echo "6/6 FALLO. Últimas líneas del log:"
  tail -20 "$DEST/server.log" 2>/dev/null || true
  exit 1
fi
