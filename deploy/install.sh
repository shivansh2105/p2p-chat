#!/usr/bin/env bash
# One-command install of the P2P Chat headless server (Ubuntu/Debian, x64 or ARM64
# — VPS, old PC, Raspberry Pi 4/5). Re-run to update.
#
#   curl -fsSL https://raw.githubusercontent.com/shivansh2105/p2p-chat/master/deploy/install.sh | sudo bash
#   # optional:  ... | sudo P2P_PUBLIC_IP=203.0.113.10 P2P_STORAGE_GB=100 bash
set -euo pipefail

REPO="${P2P_REPO:-https://github.com/shivansh2105/p2p-chat.git}"
DIR=/opt/p2p-chat
ENV_FILE=/etc/p2p-chat.env
NODE_MAJOR=22

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)."; exit 1; }
command -v apt-get >/dev/null || { echo "This installer supports Debian/Ubuntu (apt). Use Docker elsewhere."; exit 1; }

echo "==> Installing packages"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates >/dev/null

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "==> Installing Node.js ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "    node $(node -v)"

id p2pchat >/dev/null 2>&1 || useradd --system --home /var/lib/p2p-chat --create-home --shell /usr/sbin/nologin p2pchat

echo "==> Fetching code"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only -q; else git clone -q --depth 1 "$REPO" "$DIR"; fi
cd "$DIR"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null
chown -R p2pchat:p2pchat /var/lib/p2p-chat

if [ ! -f "$ENV_FILE" ]; then
  echo "==> Writing $ENV_FILE (edit it to change settings)"
  PUBIP="${P2P_PUBLIC_IP:-$(curl -fsS4 --max-time 5 https://api.ipify.org || true)}"
  cat > "$ENV_FILE" <<EOF
P2P_DATA=/var/lib/p2p-chat
P2P_NAME=${P2P_NAME:-server}
P2P_TCP=${P2P_TCP:-4001}
P2P_WS=${P2P_WS:-4002}
# Public IPv4 of this machine (leave empty at home behind NAT → free Cloudflare tunnel is used)
P2P_PUBLIC_IP=${PUBIP}
P2P_STORAGE_GB=${P2P_STORAGE_GB:-50}
P2P_HTTP=8080
EOF
fi

echo "==> Installing systemd service"
cp deploy/p2p-chat.service /etc/systemd/system/p2p-chat.service
systemctl daemon-reload
systemctl enable --now p2p-chat >/dev/null
systemctl restart p2p-chat

if command -v ufw >/dev/null && ufw status | grep -q active; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  ufw allow "${P2P_TCP:-4001}/tcp" >/dev/null; ufw allow "${P2P_WS:-4002}/tcp" >/dev/null
  echo "    firewall: opened ${P2P_TCP:-4001}, ${P2P_WS:-4002}"
fi

echo "==> Waiting for the node"
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1 && break; sleep 2; done
curl -fsS http://127.0.0.1:8080/health || { echo "Not healthy yet — check: journalctl -u p2p-chat -f"; exit 1; }
echo
echo "Done. Logs: journalctl -u p2p-chat -f   Status: curl localhost:8080/health"
echo "Cloud VPS? Also open TCP ${P2P_TCP:-4001} and ${P2P_WS:-4002} in your provider's firewall/security list."
