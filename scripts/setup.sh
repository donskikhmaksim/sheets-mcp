#!/bin/bash
# Google MCP (Sheets/Docs/Drive/Gmail/Calendar) — автоматическая установка
# Этот скрипт запускается один раз и настраивает всё за тебя
#
# Совместим со старым bash 3.2 (macOS по умолчанию) — без ассоциативных
# массивов, только indexed arrays + case.
#
# Безопасно перезапускать: проект и уже созданные сервисы переиспользуются,
# а не плодятся заново.

set -e

# ── Парсинг аргументов ─────────────────────────────────────────────────────
CLIENT_ID=""
CLIENT_SECRET=""
RELAY_SECRET=""
# Общий OAuth-релей: держит единственный redirect_uri, зарегистрированный в
# Google один раз навсегда. Он token-blind — токенов не видит, только пересылает
# одноразовый код на твой сервер. Домен по умолчанию можно переопределить.
RELAY_URL="https://maksims-mac-mini.taild91c23.ts.net"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --client-id)     CLIENT_ID="$2";     shift 2 ;;
    --client-secret) CLIENT_SECRET="$2"; shift 2 ;;
    --relay-secret)  RELAY_SECRET="$2";  shift 2 ;;
    --relay-url)     RELAY_URL="$2";     shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" || -z "$RELAY_SECRET" ]]; then
  echo "❌ Скрипт должен быть запущен с ключами --client-id, --client-secret и --relay-secret"
  echo "   Получи персональную команду у того, кто тебе прислал эту инструкцию."
  exit 1
fi

PROJECT_NAME="google-mcp"
REPOS=(sheets-mcp docs-mcp drive-mcp gmail-mcp calendar-mcp)

# Один секрет дашборда на все 5 сервисов человека (они делят одну базу, так что
# аккаунт добавляется один раз и виден всем). Ссылка вида /dashboard/<секрет>.
DASHBOARD_SECRET=$(LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 32)

label_for() {
  case "$1" in
    sheets-mcp)   echo "Google Sheets" ;;
    docs-mcp)     echo "Google Docs" ;;
    drive-mcp)    echo "Google Drive" ;;
    gmail-mcp)    echo "Gmail" ;;
    calendar-mcp) echo "Google Calendar" ;;
  esac
}

# ── Цвета ──────────────────────────────────────────────────────────────────
BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
CYAN="\033[0;36m"
RESET="\033[0m"

step() { echo -e "\n${BOLD}${CYAN}▶ $1${RESET}"; }
ok()   { echo -e "${GREEN}✓ $1${RESET}"; }
ask()  { echo -e "${YELLOW}➜ $1${RESET}"; }
fail() {
  echo -e "${RED}✗ $1${RESET}" >&2
  if [[ -n "$2" && -f "$2" ]]; then
    echo "--- подробности ---" >&2
    tail -20 "$2" >&2
    echo "" >&2
    echo -e "${YELLOW}Полный лог сохранён в: $2${RESET}" >&2
    echo "Если пишешь тому, кто прислал скрипт — пришли этот файл целиком," >&2
    echo "а не текст из терминала (он часто обрезается при копировании)." >&2
  fi
  exit 1
}

LOG="$HOME/google-mcp-setup.log"
: > "$LOG"  # обнуляем лог этого запуска, но файл не удаляем — пригодится для диагностики

clear 2>/dev/null || true
echo -e "${BOLD}╔══════════════════════════════════════════╗"
echo -e "║   Google MCP — установка                 ║"
echo -e "╚══════════════════════════════════════════╝${RESET}"
echo ""
echo "Скрипт задеплоит 5 персональных серверов на Railway"
echo "(Sheets, Docs, Drive, Gmail, Calendar) и подключит их к Claude."
echo "Займёт ~5-7 минут."

# ── Шаг 1: Railway CLI ─────────────────────────────────────────────────────
# Версия закреплена намеренно: команды этого скрипта проверены строго под
# 5.17.0. Между версиями Railway CLI менялся синтаксис подкоманд
# (например, `railway service source connect`) — "последняя версия" может
# оказаться несовместимой.
RAILWAY_PIN="5.17.0"
step "1/4  Проверяю Railway CLI (нужна версия $RAILWAY_PIN)"

CURRENT_VERSION=$(railway --version 2>/dev/null | awk '{print $2}')

if [[ "$CURRENT_VERSION" != "$RAILWAY_PIN" ]]; then
  echo "Устанавливаю Railway CLI $RAILWAY_PIN..."
  if command -v npm &>/dev/null; then
    npm install -g "@railway/cli@$RAILWAY_PIN" >>"$LOG" 2>&1 || fail "Не смог установить Railway CLI через npm." "$LOG"
  elif command -v brew &>/dev/null; then
    echo "  npm не найден — ставлю через brew (может подтянуться другая версия)."
    brew install railway >>"$LOG" 2>&1 || fail "Не смог установить Railway CLI через brew." "$LOG"
  else
    echo "  Ни npm, ни brew не найдены — ставлю через официальный установщик."
    curl -fsSL https://railway.app/install.sh | sh >>"$LOG" 2>&1 || fail "Не смог установить Railway CLI." "$LOG"
    export PATH="$HOME/.railway/bin:$PATH"
  fi
fi

FINAL_VERSION=$(railway --version 2>/dev/null | awk '{print $2}')
if [[ "$FINAL_VERSION" != "$RAILWAY_PIN" ]]; then
  echo -e "${YELLOW}⚠️  Установилась версия $FINAL_VERSION вместо $RAILWAY_PIN.${RESET}"
  echo "   Если дальше что-то пойдёт не так — вероятно, дело в этом несовпадении."
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

# Переиспользуем проект, если он уже был создан прошлым запуском.
# (Разбор JSON через grep/sed — без зависимости от python3, его нет "из коробки"
# на свежих macOS.) В выводе `railway list --json` поле "id" идёт прямо перед
# "name" для каждого проекта, поэтому берём одну строку назад от совпадения.
EXISTING_PROJECT_ID=$(railway list --json 2>>"$LOG" \
  | grep -B1 "\"name\": *\"$PROJECT_NAME\"" \
  | grep '"id"' \
  | head -1 \
  | sed -E 's/.*"id": *"([^"]+)".*/\1/' || true)

LINKED=false
if [[ -n "$EXISTING_PROJECT_ID" ]]; then
  echo "Нашёл существующий проект, переиспользую его..."
  if railway link --project "$EXISTING_PROJECT_ID" --environment production --json >>"$LOG" 2>&1; then
    LINKED=true
  else
    # Проект мог быть удалён вручную — Railway иногда ещё пару секунд
    # показывает его в списке (устаревший кэш). В этом случае просто
    # создаём новый, а не падаем.
    echo "  Похоже, этот проект уже удалён — создаю новый."
  fi
fi

if [[ "$LINKED" == false ]]; then
  echo "Создаю проект..."
  railway init --name "$PROJECT_NAME" --json >>"$LOG" 2>&1 || fail "Не смог создать проект на Railway." "$LOG"
fi

# Postgres: добавляем только если ещё не создан.
HAS_POSTGRES=$(railway service list --json 2>>"$LOG" | grep -c '"name": *"Postgres"' || true)
if [[ "$HAS_POSTGRES" -eq 0 ]]; then
  echo "Добавляю общую базу данных..."
  railway add --database postgres --json >>"$LOG" 2>&1 || fail "Не смог добавить Postgres." "$LOG"
else
  echo "База данных уже есть, пропускаю."
fi

# Ждёт пока деплой сервиса перестанет быть "в процессе", затем запускает
# явный редеплой. Обходит гонку: service source connect сам запускает сборку,
# и если она ещё не закончилась, обычный `railway redeploy` падает с
# "cannot be redeployed... currently building" — здесь это ожидаемо, не ошибка.
redeploy_with_retry() {
  local repo="$1"
  local attempt=0
  local max_attempts=24  # до ~4 минут ожидания

  while true; do
    if railway redeploy --service "$repo" --yes --json >>"$LOG" 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    if [[ $attempt -ge $max_attempts ]]; then
      fail "Не получилось запустить сборку для $repo после $max_attempts попыток." "$LOG"
    fi
    sleep 10
  done
}

DOMAINS=()

for repo in "${REPOS[@]}"; do
  label=$(label_for "$repo")
  echo ""
  echo "── ${label} ──"

  ALREADY_EXISTS=$(railway service list --json 2>>"$LOG" | grep -c "\"name\": *\"$repo\"" || true)

  if [[ "$ALREADY_EXISTS" -eq 0 ]]; then
    echo "  Создаю сервис..."
    STEP_OUT=$(mktemp)
    if ! railway add --service "$repo" --json >"$STEP_OUT" 2>&1; then
      if grep -qi "already exists" "$STEP_OUT"; then
        echo "  (сервис уже был создан раньше — это нормально при повторном запуске)"
      else
        cat "$STEP_OUT" >> "$LOG"; rm -f "$STEP_OUT"
        fail "Не смог создать сервис $repo." "$LOG"
      fi
    fi
    cat "$STEP_OUT" >> "$LOG"; rm -f "$STEP_OUT"
  else
    echo "  Сервис уже существует, обновляю переменные и передеплою."
  fi

  # Подключаем источник ВСЕГДА, даже если сервис уже был — прошлая неудачная
  # попытка могла создать пустой сервис и упасть до этого шага (например,
  # из-за несовместимой версии Railway CLI). Без источника `redeploy` вечно
  # будет отвечать "No deployment found for service", сколько ни повторяй.
  echo "  Подключаю код..."
  STEP_OUT=$(mktemp)
  if ! railway service source connect --repo "donskikhmaksim/$repo" --branch main --service "$repo" --json >"$STEP_OUT" 2>&1; then
    if grep -qi "already" "$STEP_OUT"; then
      echo "  (источник уже был подключён раньше — это нормально)"
    else
      cat "$STEP_OUT" >> "$LOG"; rm -f "$STEP_OUT"
      fail "Не смог подключить GitHub-репозиторий для $repo." "$LOG"
    fi
  fi
  cat "$STEP_OUT" >> "$LOG"; rm -f "$STEP_OUT"

  KEY=$(LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 64)
  echo "  Задаю переменные..."
  railway variable set "DATABASE_URL=\${{Postgres.DATABASE_URL}}" --service "$repo" --skip-deploys --json >>"$LOG" 2>&1 \
    || fail "Не смог задать DATABASE_URL для $repo." "$LOG"
  railway variable set "TOKEN_ENC_KEY=$KEY" --service "$repo" --skip-deploys --json >>"$LOG" 2>&1 \
    || fail "Не смог задать TOKEN_ENC_KEY для $repo." "$LOG"
  railway variable set "ONBOARDING_GOOGLE_CLIENT_ID=$CLIENT_ID" --service "$repo" --skip-deploys --json >>"$LOG" 2>&1 \
    || fail "Не смог задать ONBOARDING_GOOGLE_CLIENT_ID для $repo." "$LOG"
  railway variable set "ONBOARDING_GOOGLE_CLIENT_SECRET=$CLIENT_SECRET" --service "$repo" --skip-deploys --json >>"$LOG" 2>&1 \
    || fail "Не смог задать ONBOARDING_GOOGLE_CLIENT_SECRET для $repo." "$LOG"
  railway variable set "OAUTH_RELAY_URL=$RELAY_URL" --service "$repo" --skip-deploys --json >>"$LOG" 2>&1 \
    || fail "Не смог задать OAUTH_RELAY_URL для $repo." "$LOG"
  railway variable set "OAUTH_RELAY_SECRET=$RELAY_SECRET" --service "$repo" --skip-deploys --json >>"$LOG" 2>&1 \
    || fail "Не смог задать OAUTH_RELAY_SECRET для $repo." "$LOG"
  railway variable set "DASHBOARD_SECRET=$DASHBOARD_SECRET" --service "$repo" --skip-deploys --json >>"$LOG" 2>&1 \
    || fail "Не смог задать DASHBOARD_SECRET для $repo." "$LOG"

  echo "  Генерирую домен..."
  DOMAIN_JSON=$(railway domain --service "$repo" --json 2>>"$LOG") || fail "Не смог создать домен для $repo." "$LOG"
  DOMAIN=$(echo "$DOMAIN_JSON" | grep -oE '[a-z0-9-]+\.up\.railway\.app' | head -1)
  if [[ -z "$DOMAIN" ]]; then
    # Домен уже существовал — берём его из списка доменов сервиса.
    DOMAIN=$(railway domain list --service "$repo" --json 2>>"$LOG" | grep -oE '[a-z0-9-]+\.up\.railway\.app' | head -1)
  fi
  DOMAINS+=("$DOMAIN")

  echo "  Запускаю сборку (может занять пару попыток, это нормально)..."
  redeploy_with_retry "$repo"
done

echo ""
echo "Жду, пока все серверы поднимутся..."
i=0
for repo in "${REPOS[@]}"; do
  domain="${DOMAINS[$i]}"
  waited=0
  until curl -sf "https://$domain/health" &>/dev/null; do
    sleep 5
    waited=$((waited + 5))
    if [[ $waited -ge 300 ]]; then
      fail "$(label_for "$repo") не поднялся за 5 минут. Проверь логи в Railway (railway logs --service $repo)." ""
    fi
  done
  echo "  ✓ $(label_for "$repo") готов"
  i=$((i + 1))
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
i=0
for repo in "${REPOS[@]}"; do
  domain="${DOMAINS[$i]}"
  printf "  %-16s ${CYAN}https://%s/mcp${RESET}\n" "$(label_for "$repo")" "$domain"
  i=$((i + 1))
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
echo -e "${BOLD}Несколько почт?${RESET} Открой свой дашборд и жми «Добавить аккаунт»:"
echo ""
echo -e "  ${CYAN}https://${DOMAINS[0]}/dashboard/${DASHBOARD_SECRET}${RESET}"
echo ""
echo "  Там можно подключить несколько своих Google-аккаунтов, дать им метки"
echo "  (например personal / work) и выбрать основной. В Claude переключайся"
echo "  между ними параметром account. Токены хранятся только на твоём сервере."
echo ""
echo -e "${BOLD}Проверка:${RESET} напиши Claude «Покажи мои файлы на Google Диске»"
