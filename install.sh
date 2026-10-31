#!/usr/bin/env bash
# Hold The Line — install / update on Ubuntu (EC2).
#   First run:  AI_KEY=gsk_xxx bash install.sh
#   Update:     git pull && bash install.sh
# No domain? It uses a free <server-ip>.sslip.io hostname with real https (the mic needs https).
# Own domain: DOMAIN=game.example.com bash install.sh     Skip Nginx/https: NO_NGINX=1 bash install.sh
set -e
cd "$(dirname "$0")"
APP=holdtheline

# Node 18+
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# .env
if [ ! -f .env ]; then cp .env.example .env; chmod 600 .env; fi
if [ -n "$AI_KEY" ]; then sed -i "s|^AI_KEY=.*|AI_KEY=$AI_KEY|" .env; fi
if ! grep -q '^AI_KEY=.\+' .env; then
  read -rp "Groq API key (gsk_...): " K
  sed -i "s|^AI_KEY=.*|AI_KEY=$K|" .env
fi
PORT=$(grep '^PORT=' .env | cut -d= -f2); PORT=${PORT:-3070}

# PM2
command -v pm2 >/dev/null || sudo npm i -g pm2
if pm2 describe $APP >/dev/null 2>&1; then pm2 restart $APP --update-env; else pm2 start server.js --name $APP; fi
pm2 save >/dev/null

# Nginx + SSL
[ -f .domain ] && [ -z "$DOMAIN" ] && DOMAIN=$(cat .domain)
if [ -z "$DOMAIN" ] && [ -z "$NO_NGINX" ]; then
  IP=$(curl -fsS -m 5 https://checkip.amazonaws.com || true)
  [ -n "$IP" ] && DOMAIN="$(echo "$IP" | tr . -).sslip.io"
fi
if [ -n "$DOMAIN" ] && [ -z "$NO_NGINX" ] && [ -f /etc/nginx/sites-available/$APP ] && grep -q "server_name $DOMAIN;" /etc/nginx/sites-available/$APP; then
  echo "> Updated. Live at https://$DOMAIN"
elif [ -n "$DOMAIN" ] && [ -z "$NO_NGINX" ]; then
  echo "$DOMAIN" > .domain
  command -v nginx >/dev/null || sudo apt-get install -y nginx
  sudo tee /etc/nginx/sites-available/$APP >/dev/null <<NGX
server {
  listen 80;
  server_name $DOMAIN;
  client_max_body_size 4m;
  location / {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_read_timeout 60s;
  }
}
NGX
  sudo ln -sf /etc/nginx/sites-available/$APP /etc/nginx/sites-enabled/$APP
  sudo nginx -t && sudo systemctl reload nginx
  command -v certbot >/dev/null || sudo apt-get install -y certbot python3-certbot-nginx
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect \
    || echo "! https failed: open ports 80 and 443 in the EC2 security group, then re-run bash install.sh"
  echo "> Live at https://$DOMAIN"
else
  echo "> Running on http://<server-ip>:$PORT (pm2: $APP). Open that port in the security group. Mic won't work without https."
fi
