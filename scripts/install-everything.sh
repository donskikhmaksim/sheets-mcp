#!/bin/bash
# Единая установка ВСЕГО: 5 Google MCP серверов (Sheets/Docs/Drive/Gmail/
# Calendar) + TickTick MCP — одной командой. Работает и для первой установки,
# и для обновления уже существующей (оба вложенных скрипта это умеют).
#
# Это ТОНКАЯ обёртка: реальная работа — в scripts/setup.sh каждого репо
# (donskikhmaksim/sheets-mcp и donskikhmaksim/ticktick-mcp). Здесь только
# передаём аргументы и печатаем общий итог. Один источник правды на сервис —
# логика деплоя не дублируется.

set -e

GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
RELAY_SECRET=""
RELAY_URL="https://relay.fix-roll.com"
TICKTICK_CLIENT_ID=""
TICKTICK_CLIENT_SECRET=""
TIMEZONE=""   # пусто = каждый вложенный скрипт сам определит по этому компьютеру
# Токены апдейтера — один и тот же человек, один Railway-аккаунт и один
# GitHub-аккаунт на оба проекта, поэтому пробрасываем в обе части одинаково.
RAILWAY_UPDATER_TOKEN=""
GITHUB_UPDATER_TOKEN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --google-client-id)      GOOGLE_CLIENT_ID="$2";      shift 2 ;;
    --google-client-secret)  GOOGLE_CLIENT_SECRET="$2";  shift 2 ;;
    --relay-secret)          RELAY_SECRET="$2";          shift 2 ;;
    --relay-url)             RELAY_URL="$2";              shift 2 ;;
    --ticktick-client-id)    TICKTICK_CLIENT_ID="$2";    shift 2 ;;
    --ticktick-client-secret) TICKTICK_CLIENT_SECRET="$2"; shift 2 ;;
    --timezone)              TIMEZONE="$2";               shift 2 ;;
    --railway-token)         RAILWAY_UPDATER_TOKEN="$2"; shift 2 ;;
    --github-token)          GITHUB_UPDATER_TOKEN="$2";  shift 2 ;;
    *) shift ;;
  esac
done

BOLD="\033[1m"; GREEN="\033[0;32m"; CYAN="\033[0;36m"; RESET="\033[0m"

if [[ -z "$GOOGLE_CLIENT_ID" || -z "$GOOGLE_CLIENT_SECRET" || -z "$RELAY_SECRET" \
      || -z "$TICKTICK_CLIENT_ID" || -z "$TICKTICK_CLIENT_SECRET" ]]; then
  echo "❌ Нужны все ключи: --google-client-id --google-client-secret --relay-secret"
  echo "   --ticktick-client-id --ticktick-client-secret"
  echo "   Получи персональную команду у того, кто тебе прислал эту инструкцию."
  exit 1
fi

echo -e "${BOLD}╔══════════════════════════════════════════╗"
echo -e "║   Полная установка: Google + TickTick    ║"
echo -e "╚══════════════════════════════════════════╝${RESET}"
echo ""
echo "Это две независимые установки одна за другой — сначала 5 Google-серверов,"
echo "потом TickTick. Суммарно ~10-12 минут."

TZ_ARGS=()
[[ -n "$TIMEZONE" ]] && TZ_ARGS=(--timezone "$TIMEZONE")
TOKEN_ARGS=()
[[ -n "$RAILWAY_UPDATER_TOKEN" ]] && TOKEN_ARGS+=(--railway-token "$RAILWAY_UPDATER_TOKEN")
[[ -n "$GITHUB_UPDATER_TOKEN" ]]  && TOKEN_ARGS+=(--github-token "$GITHUB_UPDATER_TOKEN")

echo ""
echo -e "${CYAN}▶ Часть 1/2 — Google (Sheets/Docs/Drive/Gmail/Calendar)${RESET}"
bash <(curl -fsSL https://raw.githubusercontent.com/donskikhmaksim/sheets-mcp/main/scripts/setup.sh) \
  --client-id "$GOOGLE_CLIENT_ID" \
  --client-secret "$GOOGLE_CLIENT_SECRET" \
  --relay-secret "$RELAY_SECRET" \
  --relay-url "$RELAY_URL" \
  "${TOKEN_ARGS[@]}"

echo ""
echo -e "${CYAN}▶ Часть 2/2 — TickTick${RESET}"
bash <(curl -fsSL https://raw.githubusercontent.com/donskikhmaksim/ticktick-mcp/main/scripts/setup.sh) \
  --client-id "$TICKTICK_CLIENT_ID" \
  --client-secret "$TICKTICK_CLIENT_SECRET" \
  "${TZ_ARGS[@]}" \
  "${TOKEN_ARGS[@]}"

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════╗"
echo -e "║   ✅  Всё готово: 6 серверов              ║"
echo -e "╚══════════════════════════════════════════╝${RESET}"
echo ""
echo "Ссылки для Claude — смотри в выводе выше (каждая часть печатает свои)."
echo "Добавляй в Claude: Settings → Connectors → Add custom connector."
