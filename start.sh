#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LAN_IP="${QWEN_STUDIO_LAN_IP:-}"
if [[ -z "$LAN_IP" ]]; then
  LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' || true)"
fi
HOSTS=(--host 127.0.0.1)
case "$LAN_IP" in
  10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) HOSTS+=(--host "$LAN_IP") ;;
esac
exec "$APP_DIR/../.venv/bin/python" "$APP_DIR/server.py" "${HOSTS[@]}" "$@"
