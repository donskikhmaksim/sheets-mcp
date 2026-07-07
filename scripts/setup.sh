#!/bin/bash
# Google MCP (Sheets/Docs/Drive/Gmail/Calendar) — автоматическая установка
# Этот скрипт запускается один раз и настраивает всё за тебя

set -e

# ── Парсинг аргументов ─────────────────────────────────────────────────────
CLIENT_ID=""
CLIENT_SECRET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --client-id)     CLIENT_ID="$2";     shift 2 ;;
    --client-secret) CLIENT_SECRET="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
  echo "❌ Скрипт должен быть запущен с ключами --client-id и --client-secret"
  echo "   Получи персональную команду у того, кто тебе прислал эту инструкцию."
  exit 1
fi

REPOS=(sheets-mcp docs-mcp drive-mcp gmail-mcp calendar-mcp)
declare -A LABELS=(
  [sheets-mcp]="Google Sheets"
  [docs-mcp]="Google Docs"
  [drive-mcp]="Google Drive"
  [gmail-mcp]="Gmail"
  [calendar-mcp]="Google Calendar"
)

# ── Цвета ──────────────────────────────────────────────────────────────────
BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
CYAN="\033[0;36m"
RESET="\033[0m"

step() { echo -e "\n${BOLD}${CYAN}▶ $1${RESET}"; }
ok()   { echo -e "${GREEN}✓ $1${RESET}"; }
ask()  { echo -e "${YELLOW}➜ $1${RESET}"; }

clear
echo -e "${BOLD}╔══════════════════════════════════════════╗"
echo -e "║   Google MCP — установка                 ║"
echo -e "╚══════════════════════════════════════════╝${RESET}"
echo ""
echo "Скрипт задеплоит 5 персональных серверов на Railway"
echo "(Sheets, Docs, Drive, Gmail, Calendar) и подключит их к Claude."
echo "Займёт ~5-7 минут."

# ── Шаг 1: Railway CLI ─────────────────────────────────────────────────────
step "1/4  Проверяю Railway CLI"

if ! command -v railway &>/dev/null; then
  echo "Устанавливаю Railway CLI..."
  if command -v brew &>/dev/null; then
    brew install railway
  else
    curl -fsSL https://railway.app/install.sh | sh
    export PATH="$HOME/.railway/bin:$PATH"
  fi
fi
ok "Railway CLI $(railway --version 2>&1 | head -1)"

# ── Шаг 2: Логин в Railway ─────────────────────────────────────────────────
step "2/4  Войди в Railway"
echo ""
echo "Сейчас откроется браузер — войди в свой аккаунт Railway."
echo "(Если аккаунта нет — создай на railway.app, это бесплатно)"
echo ""
ask "Нажми Enter чтобы открыть браузер..."
read -r

railway login

ok "Авторизован в Railway"

# ── Шаг 3: Деплой ───────────────────────────────────────────────────────────
step "3/4  Деплою серверы (это самая долгая часть, ~3-5 минут)"

WORK_DIR=$(mktemp -d)
cd "$WORK_DIR"

echo "Создаю проект..."
railway init --name "google-mcp" --json > /tmp/gmcp_init.json 2>&1
cat /tmp/gmcp_init.json | tail -1

echo "Добавляю общую базу данных..."
railway add --database postgres --json 2>&1 | tail -1

declare -A DOMAINS

for repo in "${REPOS[@]}"; do
  label="${LABELS[$repo]}"
  echo ""
  echo "── ${label} ──"

  echo "  Создаю сервис..."
  railway add --service "$repo" --json 2>&1 | tail -1

  echo "  Подключаю код..."
  railway service source connect --repo "donskikhmaksim/$repo" --branch main --service "$repo" --json 2>&1 | tail -1

  KEY=$(LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 64)
  echo "  Задаю переменные..."
  railway variable set "DATABASE_URL=\${{Postgres.DATABASE_URL}}" --service "$repo" --skip-deploys --json > /dev/null 2>&1
  railway variable set "TOKEN_ENC_KEY=$KEY" --service "$repo" --skip-deploys --json > /dev/null 2>&1
  railway variable set "ONBOARDING_GOOGLE_CLIENT_ID=$CLIENT_ID" --service "$repo" --skip-deploys --json > /dev/null 2>&1
  railway variable set "ONBOARDING_GOOGLE_CLIENT_SECRET=$CLIENT_SECRET" --service "$repo" --skip-deploys --json > /dev/null 2>&1

  echo "  Генерирую домен..."
  DOMAIN_JSON=$(railway domain --service "$repo" --json 2>&1)
  DOMAIN=$(echo "$DOMAIN_JSON" | grep -oE '[a-z0-9-]+\.up\.railway\.app' | head -1)
  DOMAINS[$repo]="$DOMAIN"

  echo "  Запускаю сборку..."
  railway redeploy --service "$repo" --yes --json > /dev/null 2>&1
done

echo ""
echo "Жду, пока все серверы поднимутся..."
for repo in "${REPOS[@]}"; do
  domain="${DOMAINS[$repo]}"
  until curl -sf "https://$domain/health" &>/dev/null; do
    sleep 5
  done
  echo "  ✓ ${LABELS[$repo]} готов"
done

cd /
rm -rf "$WORK_DIR"

ok "Все 5 серверов запущены"

# ── Готово ──────────────────────────────────────────────────────────────────
step "4/4  Готово"

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════╗"
echo -e "║   ✅  Всё готово!                        ║"
echo -e "╚══════════════════════════════════════════╝${RESET}"
echo ""
echo -e "${BOLD}Ссылки для Claude${RESET} (добавь только те, что нужны):"
echo ""
for repo in "${REPOS[@]}"; do
  domain="${DOMAINS[$repo]}"
  printf "  %-16s ${CYAN}https://%s/mcp${RESET}\n" "${LABELS[$repo]}" "$domain"
done
echo ""
echo -e "${BOLD}Как добавить в Claude${RESET} (повтори для каждой ссылки):"
echo "  1. Открой claude.ai → профиль → Settings → Connectors"
echo "  2. Нажми Add custom connector"
echo "  3. Вставь ссылку выше → Save"
echo "  4. Откроется окно входа Google — войди своим аккаунтом и нажми Allow"
echo ""
echo "  Если увидишь экран «Google hasn't verified this app» — это нормально,"
echo "  нажми Advanced → Go to ... (unsafe) → Allow."
echo ""
echo -e "${BOLD}Важно:${RESET} логиниться в Google нужно только один раз — при первом"
echo "подключённом сервисе. Остальные 4 подхватят тот же аккаунт сами."
echo ""
echo -e "${BOLD}Проверка:${RESET} напиши Claude «Покажи мои файлы на Google Диске»"
