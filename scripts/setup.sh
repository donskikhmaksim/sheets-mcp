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
RELAY_URL="https://relay.fix-roll.com"

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
UPSTREAM_OWNER="donskikhmaksim"
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
echo "Скрипт форкнет 5 репозиториев на твой GitHub, задеплоит твои персональные"
echo "серверы на Railway из этих форков (Sheets, Docs, Drive, Gmail, Calendar)"
echo "и подключит их к Claude. Займёт ~5-7 минут."

# ── Шаг 1: Railway CLI ─────────────────────────────────────────────────────
# Нужен Railway CLI ≥ 5.17 (все команды скрипта работают одинаково на 5.17–5.24+).
# Если railway уже установлен любой свежей версии — используем его как есть и
# ничего не переустанавливаем (иначе npm падает с EEXIST поверх brew-бинарника).
MIN_MAJOR=5
step "1/5  Проверяю Railway CLI"

if command -v railway &>/dev/null; then
  CURRENT_VERSION=$(railway --version 2>/dev/null | awk '{print $2}')
  MAJOR=$(echo "$CURRENT_VERSION" | cut -d. -f1)
  if [[ -n "$MAJOR" && "$MAJOR" -ge "$MIN_MAJOR" ]]; then
    : # подходящая версия уже стоит — ничего не делаем
  else
    echo -e "${YELLOW}⚠️  Установлена старая версия Railway CLI ($CURRENT_VERSION). Обнови её:${RESET}"
    echo "   brew upgrade railway   (или npm i -g @railway/cli@latest), затем запусти команду снова."
    fail "Нужен Railway CLI версии ${MIN_MAJOR}.x или новее." "$LOG"
  fi
else
  echo "Railway CLI не найден — устанавливаю..."
  if command -v brew &>/dev/null; then
    brew install railway >>"$LOG" 2>&1 || fail "Не смог установить Railway CLI через brew." "$LOG"
  elif command -v npm &>/dev/null; then
    npm install -g @railway/cli >>"$LOG" 2>&1 || fail "Не смог установить Railway CLI через npm." "$LOG"
  else
    curl -fsSL https://railway.app/install.sh | sh >>"$LOG" 2>&1 || fail "Не смог установить Railway CLI." "$LOG"
    export PATH="$HOME/.railway/bin:$PATH"
  fi
  command -v railway &>/dev/null || fail "Railway CLI не установился." "$LOG"
fi
ok "Railway CLI $(railway --version 2>&1 | head -1)"

# ── Шаг 2: GitHub CLI + форки ────────────────────────────────────────────────
# Railway должен деплоить каждый из 5 сервисов из ТВОЕГО форка, а не из
# апстрима (donskikhmaksim/*) напрямую — иначе (а) нет механизма обновлений
# и (б) не факт что GitHub-интеграция Railway вообще стабильно работает на
# чужом репозитории в долгосрочной перспективе. Форкаем идемпотентно (gh repo
# fork безопасно повторять) и включаем Actions на форке, чтобы workflow
# синхронизации с апстримом (если он есть в репозитории) мог работать.
step "2/5  Форкаю репозитории на твой GitHub"

if ! command -v gh &>/dev/null; then
  echo -e "${YELLOW}⚠️  GitHub CLI (gh) не найден.${RESET}"
  echo "   Установи: brew install gh   (или https://cli.github.com)"
  echo "   Без него не смогу форкнуть репозитории автоматически."
fi

if command -v gh &>/dev/null && ! gh auth status &>/dev/null; then
  echo ""
  echo "Нужен вход в GitHub (для форка репозиториев и автообновлений)."
  if [[ -t 0 ]]; then
    ask "Нажми Enter чтобы открыть браузер и войти в GitHub..."
    read -r
  fi
  gh auth login || true
fi

GH_USER=""
if command -v gh &>/dev/null && gh auth status &>/dev/null; then
  GH_USER=$(gh api user --jq .login 2>>"$LOG" || true)
fi

if [[ -n "$GH_USER" ]]; then
  for repo in "${REPOS[@]}"; do
    echo "  Форкаю $UPSTREAM_OWNER/$repo → $GH_USER/$repo (идемпотентно)..."
    gh repo fork "$UPSTREAM_OWNER/$repo" --clone=false >>"$LOG" 2>&1 || true
    # Форк создаётся асинхронно — ждём, пока появится, прежде чем включать Actions.
    for _ in 1 2 3 4 5 6; do
      gh repo view "$GH_USER/$repo" &>/dev/null && break
      sleep 5
    done
    if gh repo view "$GH_USER/$repo" &>/dev/null; then
      gh api -X PUT "repos/$GH_USER/$repo/actions/permissions" \
        -F enabled=true -f allowed_actions=all >>"$LOG" 2>&1 || true
    else
      echo -e "${YELLOW}    Форк $repo не появился вовремя — если ниже упадёт подключение${RESET}"
      echo -e "${YELLOW}    источника, зайди на github.com и форкни его вручную.${RESET}"
    fi
  done
  ok "Форки готовы под аккаунтом $GH_USER"
else
  echo ""
  echo -e "${YELLOW}Не удалось форкнуть автоматически (нужен GitHub CLI 'gh', авторизованный).${RESET}"
  echo "Форкни репозитории вручную в браузере:"
  echo ""
  for repo in "${REPOS[@]}"; do
    echo -e "  ${CYAN}https://github.com/$UPSTREAM_OWNER/$repo/fork${RESET}"
  done
  echo ""
  echo "На каждом форке: вкладка Actions → «I understand the risks, enable»."
  echo ""
  if [[ -t 0 ]]; then
    ask "Введи свой GitHub-логин (владельца форков, или Enter — подключить апстрим напрямую, без обновлений):"
    read -r GH_USER
  fi
  if [[ -z "$GH_USER" ]]; then
    fail "Без форка Railway не сможет автообновляться, а подключение напрямую к $UPSTREAM_OWNER/<repo> может вообще не сработать (Railway требует доступ владельца репозитория). Прерываю — форкни репозитории (см. ссылки выше) и запусти скрипт снова, указав логин." ""
  fi
fi

# ── Шаг 3: Логин в Railway ─────────────────────────────────────────────────
step "3/5  Войди в Railway"
if railway whoami &>/dev/null; then
  ok "Уже авторизован в Railway ($(railway whoami 2>/dev/null | tail -1))"
else
  echo ""
  echo "Сейчас откроется браузер — войди в свой аккаунт Railway."
  echo "(Если аккаунта нет — создай на railway.app, это бесплатно)"
  echo ""
  # В неинтерактивном запуске (нет терминала) пропускаем паузу.
  if [[ -t 0 ]]; then
    ask "Нажми Enter чтобы открыть браузер..."
    read -r
  fi
  railway login || fail "Не удалось войти в Railway." "$LOG"
  ok "Авторизован в Railway"
fi

# ── Шаг 4: Деплой ───────────────────────────────────────────────────────────
step "4/5  Деплою серверы (это самая долгая часть, ~3-5 минут)"

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

# ── Единый ключ шифрования токенов на весь проект ───────────────────────────
# Все 5 сервисов делят ОДНУ базу и расшифровывают refresh-токены друг друга
# ОДНИМ И ТЕМ ЖЕ ключом (google_accounts.ref_enc). Поэтому ключ — один на весь
# проект, а не по сервису. При повторном запуске переиспользуем уже заданный
# ключ: иначе ранее сохранённые токены (Google-логины) станут нечитаемы и всех
# разлогинит. Ищем существующий ключ в любом из уже развёрнутых сервисов.
TOKEN_ENC_KEY=""
for repo in "${REPOS[@]}"; do
  EXISTING_KEY=$(railway variable list --service "$repo" --kv 2>>"$LOG" \
    | grep '^TOKEN_ENC_KEY=' | head -1 | cut -d= -f2- || true)
  if [[ -n "$EXISTING_KEY" ]]; then
    TOKEN_ENC_KEY="$EXISTING_KEY"
    echo "Нашёл уже заданный ключ шифрования токенов — переиспользую (логины сохранятся)."
    break
  fi
done
if [[ -z "$TOKEN_ENC_KEY" ]]; then
  TOKEN_ENC_KEY=$(LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 64)
fi

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

  # Источник — ТВОЙ форк (если удалось его завести в шаге 2/5), а не апстрим
  # напрямую: иначе у тебя нет механизма обновлений и Railway сидит на
  # репозитории, которым ты не владеешь. Фолбэк на апстрим — только если
  # форк недоступен (gh не залогинен и логин не ввели).
  CONNECT_REPO="$UPSTREAM_OWNER/$repo"
  [[ -n "$GH_USER" ]] && CONNECT_REPO="$GH_USER/$repo"

  # Подключаем источник ВСЕГДА, даже если сервис уже был — прошлая неудачная
  # попытка могла создать пустой сервис и упасть до этого шага (например,
  # из-за несовместимой версии Railway CLI). Без источника `redeploy` вечно
  # будет отвечать "No deployment found for service", сколько ни повторяй.
  echo "  Подключаю код ($CONNECT_REPO)..."
  STEP_OUT=$(mktemp)
  if ! railway service source connect --repo "$CONNECT_REPO" --branch main --service "$repo" --json >"$STEP_OUT" 2>&1; then
    if grep -qi "already" "$STEP_OUT"; then
      echo "  (источник уже был подключён раньше — это нормально)"
    else
      cat "$STEP_OUT" >> "$LOG"; rm -f "$STEP_OUT"
      fail "Не смог подключить GitHub-репозиторий $CONNECT_REPO для $repo." "$LOG"
    fi
  fi
  cat "$STEP_OUT" >> "$LOG"; rm -f "$STEP_OUT"

  echo "  Задаю переменные..."
  railway variable set "DATABASE_URL=\${{Postgres.DATABASE_URL}}" --service "$repo" --skip-deploys --json >>"$LOG" 2>&1 \
    || fail "Не смог задать DATABASE_URL для $repo." "$LOG"
  railway variable set "TOKEN_ENC_KEY=$TOKEN_ENC_KEY" --service "$repo" --skip-deploys --json >>"$LOG" 2>&1 \
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
step "5/5  Готово"

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
if [[ -n "$GH_USER" ]]; then
  echo -e "${YELLOW}Форки:${RESET} Railway задеплоен из твоих форков (github.com/$GH_USER/<repo>)."
  echo "Если в репозитории есть workflow автосинка с апстримом — обновления"
  echo "прилетят сами; иначе подтягивай их вручную (Sync fork на GitHub)."
  echo ""
fi
echo -e "${BOLD}Проверка:${RESET} напиши Claude «Покажи мои файлы на Google Диске»"
