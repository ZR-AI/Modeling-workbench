#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname -- "$APP_DIR")"
RUNTIME_DIR="$APP_DIR/.data/launcher"
PREFERRED_IP=192.168.10.24
COMFY_URL=http://127.0.0.1:8188/system_stats
WEB_URL=http://127.0.0.1:8190/api/health

fail() {
  printf '启动失败：%s\n' "$*" >&2
  exit 1
}

mkdir -p "$RUNTIME_DIR"
exec 9>"$RUNTIME_DIR/start.lock"
if ! flock -n 9; then
  printf '已有启动命令正在检查服务。\n'
  exit 0
fi

private_ip() {
  case "$1" in
    10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 0 ;;
    *) return 1 ;;
  esac
}

lan_ip() {
  local address
  if ip -4 -o addr show scope global | awk -v target="$PREFERRED_IP" '
    { split($4, address, "/"); if (address[1] == target) found = 1 }
    END { exit !found }
  '; then
    printf '%s\n' "$PREFERRED_IP"
    return
  fi
  address="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1; i<NF; i++) if ($i=="src") {print $(i+1); exit}}' || true)"
  if private_ip "$address"; then printf '%s\n' "$address"; fi
}

healthy() {
  curl --noproxy '*' --silent --fail --max-time 2 "$1" -o /dev/null
}

ensure_service() {
  local label="$1" unit="$2" port="$3" check_url="$4" log="$5" timeout="$6"
  shift 6
  if healthy "$check_url"; then
    printf '%s 已运行。\n' "$label"
    return
  fi
  systemctl --user show-environment >/dev/null 2>&1 || fail '无法连接用户服务管理器，请用本机普通用户登录后重试。'
  if ! systemctl --user is-active --quiet "$unit.service"; then
    if [[ -n "$(ss -H -ltn "sport = :$port")" ]]; then
      fail "$port 端口已被占用，$label 的健康检查未通过。"
    fi
    printf '正在启动 %s…\n' "$label"
    systemd-run --user --quiet --collect --unit="$unit" --service-type=exec \
      --property="WorkingDirectory=$PROJECT_DIR" --property="StandardOutput=append:$log" \
      --property=StandardError=inherit --setenv=PYTHONUNBUFFERED=1 "$@" \
      || fail "无法启动 $label，日志路径：$log"
  fi
  local deadline=$((SECONDS + timeout))
  until healthy "$check_url"; do
    if ! systemctl --user is-active --quiet "$unit.service" || (( SECONDS >= deadline )); then
      fail "$label 未就绪，日志路径：$log"
    fi
    sleep 1
  done
  printf '%s 已就绪。\n' "$label"
}

printf '正在检查局域网…\n'
address=""
for ((attempt=0; attempt<30; attempt++)); do
  address="$(lan_ip)"
  if [[ -n "$address" ]]; then break; fi
  sleep 2
done
[[ -n "$address" ]] || fail '未找到局域网 IPv4 地址。请确认网线或 Wi-Fi 已连接后重试。'

ensure_service 'ComfyUI' qwen-studio-comfyui 8188 "$COMFY_URL" "$RUNTIME_DIR/comfyui.log" 180 \
  "$PROJECT_DIR/start-comfyui.sh"
ensure_service '造型工作台' qwen-studio-web 8190 "$WEB_URL" "$RUNTIME_DIR/web.log" 45 \
  /usr/bin/env "QWEN_STUDIO_LAN_IP=$address" "$APP_DIR/start.sh"

lan_url="http://$address:8190"
healthy "$lan_url/api/health" || fail "本机服务已运行，但局域网地址 $lan_url/ 未响应。请确认工作台监听了当前局域网地址。"
if [[ "$address" != "$PREFERRED_IP" ]]; then
  printf '当前分配的局域网地址为 %s。\n' "$address"
fi
printf '\n同一局域网内的设备可访问：%s/\n' "$lan_url"
