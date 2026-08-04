#!/bin/bash
# Google MCP (Sheets/Docs/Drive/Gmail/Calendar) — автоматическая установка
# Этот скрипт запускается один раз и настраивает всё за тебя
#
# Совместим со старым bash 3.2 (macOS по умолчанию) — без ассоциативных
# массивов, только indexed arrays + case.
#
# Безопасно перезапускать: проект и уже созданные сервисы переиспользуются,
# а не плодятся заново.
#
# АРХИТЕКТУРА ОБНОВЛЕНИЙ: без форков и без GitHub-приложения Railway (оно
# требует ручной авторизации доступа к репозиторию в каждом аккаунте — на
# практике часто ломается с ошибкой "GitHub Repo not found"). Вместо этого
# скрипт деплоит прямо из апстрима и добавляет маленький сервис-апдейтер,
# который сам раз в час проверяет свежий коммит и сам передеплоивает —
# см. updater/updater.mjs. Единственный ручной шаг — создать 2 токена
# (Railway + GitHub) один раз, дальше всё само.

set -e

# ── Парсинг аргументов ─────────────────────────────────────────────────────
CLIENT_ID=""
CLIENT_SECRET=""
RELAY_SECRET=""
# Общий OAuth-релей: держит единственный redirect_uri, зарегистрированный в
# Google один раз навсегда. Он token-blind — токенов не видит, только пересылает
# одноразовый код на твой сервер. Домен по умолчанию можно переопределить.
RELAY_URL="https://relay.fix-roll.com"
RAILWAY_UPDATER_TOKEN=""
GITHUB_UPDATER_TOKEN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --client-id)       CLIENT_ID="$2";       shift 2 ;;
    --client-secret)   CLIENT_SECRET="$2";   shift 2 ;;
    --relay-secret)    RELAY_SECRET="$2";    shift 2 ;;
    --relay-url)       RELAY_URL="$2";       shift 2 ;;
    --railway-token)   RAILWAY_UPDATER_TOKEN="$2"; shift 2 ;;
    --github-token)    GITHUB_UPDATER_TOKEN="$2";  shift 2 ;;
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
echo "Скрипт задеплоит твои персональные серверы на Railway (Sheets, Docs,"
echo "Drive, Gmail, Calendar) и подключит их к Claude. Займёт ~5-7 минут."

# ── Шаг 1: Railway CLI ─────────────────────────────────────────────────────
# Нужен Railway CLI ≥ 5.17 (все команды скрипта работают одинаково на 5.17–5.24+).
# Если railway уже установлен любой свежей версии — используем его как есть и
# ничего не переустанавливаем (иначе npm падает с EEXIST поверх brew-бинарника).
MIN_MAJOR=5
step "1/4  Проверяю Railway CLI"

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

# ── Шаг 2: Логин в Railway ─────────────────────────────────────────────────
step "2/4  Войди в Railway"
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

# ID проекта нужен явно (не только через ambient `railway link` в этой
# директории) — deploy_fresh_code ниже клонирует репозиторий в СВОЮ ВРЕМЕННУЮ
# папку, где никакого линка нет, и передаёт -p/-e напрямую в `railway up`.
# Резолвим заново по имени — работает и для только что переиспользованного,
# и для только что созданного проекта.
PROJECT_ID=$(railway list --json 2>>"$LOG" \
  | grep -B1 "\"name\": *\"$PROJECT_NAME\"" \
  | grep '"id"' \
  | head -1 \
  | sed -E 's/.*"id": *"([^"]+)".*/\1/' || true)
[[ -n "$PROJECT_ID" ]] || fail "Не смог определить ID проекта $PROJECT_NAME." "$LOG"

# Postgres: добавляем только если ещё не создан.
HAS_POSTGRES=$(railway service list --json 2>>"$LOG" | grep -c '"name": *"Postgres"' || true)
if [[ "$HAS_POSTGRES" -eq 0 ]]; then
  echo "Добавляю общую базу данных..."
  railway add --database postgres --json >>"$LOG" 2>&1 || fail "Не смог добавить Postgres." "$LOG"
else
  echo "База данных уже есть, пропускаю."
fi

# Доставляет СЕГОДНЯШНИЙ код на сервис гарантированно. `railway redeploy`
# ЗДЕСЬ НЕ ГОДИТСЯ — он перезапускает УЖЕ СОБРАННЫЙ образ, а не тянет свежий
# коммит; при повторном запуске этого скрипта на уже существующем сервисе он
# молча оставлял старый код (баг, из-за которого раньше приходилось руками
# клонировать и катить каждый сервис). Вместо этого клонируем репозиторий
# напрямую из апстрима (форки больше не используются — см. апдейтер ниже) и
# заливаем `railway up` напрямую. Ретраим на "currently building" — если
# что-то другое сейчас параллельно собирается.
#
# subdir (необязательный 4-й аргумент) — деплоить не корень репо, а
# поддиректорию (нужно для сервиса-апдейтера, который живёт в updater/
# внутри этого же репозитория).
deploy_fresh_code() {
  # project_id передаётся ЯВНО (-p/-e прямо в `railway up`) — команда
  # выполняется из свежей ВРЕМЕННОЙ директории, где нет своего `railway link`,
  # ambient-линк текущей директории скрипта на неё не распространяется
  # (NO_LINKED_PROJECT, если этого не сделать).
  local repo="$1" connect_repo="$2" project_id="$3" subdir="${4:-}"
  local tmp
  tmp=$(mktemp -d)
  # Видимый вывод (не только в $LOG) — иначе на экране пусто по 1-3 минуты
  # пока идёт сборка, и это выглядит как зависание, хотя всё работает.
  # ВАЖНО: код возврата пайпа в `tee` — это код возврата САМОГО tee (почти
  # всегда 0), не той команды слева. Без `pipefail` берём его явно через
  # PIPESTATUS[0], иначе реальная ошибка (например, неудавшийся clone)
  # тихо считалась бы успехом.
  ( cd "$tmp" && git clone --depth 1 "https://github.com/$connect_repo.git" . --quiet ) 2>&1 | tee -a "$LOG"
  if [[ ${PIPESTATUS[0]} -ne 0 ]]; then
    rm -rf "$tmp"
    fail "Не смог скачать $connect_repo для деплоя $repo." "$LOG"
  fi

  local deploy_dir="$tmp"
  [[ -n "$subdir" ]] && deploy_dir="$tmp/$subdir"

  local attempt=0
  local max_attempts=24  # до ~4 минут ожидания
  local up_status
  while true; do
    ( cd "$deploy_dir" && railway up --service "$repo" -p "$project_id" -e production --detach ) 2>&1 | tee -a "$LOG"
    up_status=${PIPESTATUS[0]}
    if [[ $up_status -eq 0 ]]; then
      rm -rf "$tmp"
      return 0
    fi
    attempt=$((attempt + 1))
    if [[ $attempt -ge $max_attempts ]]; then
      rm -rf "$tmp"
      fail "Не получилось задеплоить свежий код для $repo после $max_attempts попыток." "$LOG"
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

  CONNECT_REPO="$UPSTREAM_OWNER/$repo"

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

  echo "  Загружаю и собираю свежий код (может занять пару попыток, это нормально)..."
  deploy_fresh_code "$repo" "$CONNECT_REPO" "$PROJECT_ID"
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

ok "Все 5 серверов запущены"

# ── Шаг 4: Апдейтер (автообновления без форков и без GitHub App) ────────────
step "4/4  Настраиваю автообновление"

echo ""
echo "Чтобы код обновлялся сам (без повторного запуска этой команды), нужен"
echo "маленький фоновый сервис. Ему нужны 2 токена — единственный ручной шаг,"
echo "который нельзя автоматизировать (ни Railway, ни GitHub не дают создать"
echo "токен программно, только руками, один раз, навсегда)."
echo ""

# Переиспользуем уже заданные токены при повторном запуске — не спрашиваем дважды.
EXISTING_RAILWAY_TOKEN=$(railway variable list --service updater --kv 2>>"$LOG" | grep '^RAILWAY_TOKEN=' | head -1 | cut -d= -f2- || true)
EXISTING_GITHUB_TOKEN=$(railway variable list --service updater --kv 2>>"$LOG" | grep '^GITHUB_TOKEN=' | head -1 | cut -d= -f2- || true)
[[ -z "$RAILWAY_UPDATER_TOKEN" && -n "$EXISTING_RAILWAY_TOKEN" ]] && RAILWAY_UPDATER_TOKEN="$EXISTING_RAILWAY_TOKEN"
[[ -z "$GITHUB_UPDATER_TOKEN" && -n "$EXISTING_GITHUB_TOKEN" ]] && GITHUB_UPDATER_TOKEN="$EXISTING_GITHUB_TOKEN"

if [[ -n "$EXISTING_RAILWAY_TOKEN" && -n "$EXISTING_GITHUB_TOKEN" ]]; then
  ok "Токены апдейтера уже заданы — переиспользую."
fi

if [[ -z "$RAILWAY_UPDATER_TOKEN" ]]; then
  echo ""
  echo -e "1. Открой ${CYAN}https://railway.com/account/tokens${RESET}"
  echo "   Впиши любое Name, выбери свой Workspace → Create → скопируй значение."
  echo ""
  if [[ -t 0 ]]; then
    ask "Вставь Railway-токен:"
    read -r -s RAILWAY_UPDATER_TOKEN
    echo ""
  fi
fi

if [[ -z "$GITHUB_UPDATER_TOKEN" ]]; then
  echo ""
  echo -e "2. Открой ${CYAN}https://github.com/settings/tokens/new${RESET}"
  echo "   Note — любой, галочки scope НЕ отмечай — Generate token → скопируй."
  echo ""
  if [[ -t 0 ]]; then
    ask "Вставь GitHub-токен:"
    read -r -s GITHUB_UPDATER_TOKEN
    echo ""
  fi
fi

if [[ -z "$RAILWAY_UPDATER_TOKEN" || -z "$GITHUB_UPDATER_TOKEN" ]]; then
  echo -e "${YELLOW}⚠️  Токены не заданы — автообновление НЕ настроено.${RESET}"
  echo "   Серверы работают, но код придётся обновлять, перезапуская эту команду."
  echo "   Чтобы включить позже: запусти команду ещё раз с --railway-token и --github-token,"
  echo "   или добавь их вручную в Variables сервиса updater в Railway."
else
  ALREADY_EXISTS=$(railway service list --json 2>>"$LOG" | grep -c '"name": *"updater"' || true)
  if [[ "$ALREADY_EXISTS" -eq 0 ]]; then
    echo "Создаю сервис updater..."
    railway add --service updater --json >>"$LOG" 2>&1 || fail "Не смог создать сервис updater." "$LOG"
  fi

  # SERVICES — репо каждого из 5 сервисов, апдейтер сверяет их все раз в час.
  SERVICES_JSON="["
  first=true
  for repo in "${REPOS[@]}"; do
    [[ "$first" == true ]] && first=false || SERVICES_JSON+=","
    SERVICES_JSON+="{\"service\":\"$repo\",\"repo\":\"$UPSTREAM_OWNER/$repo\"}"
  done
  SERVICES_JSON+="]"

  echo "Задаю переменные апдейтера..."
  railway variable set "RAILWAY_TOKEN=$RAILWAY_UPDATER_TOKEN" --service updater --skip-deploys --json >>"$LOG" 2>&1 \
    || fail "Не смог задать RAILWAY_TOKEN для updater." "$LOG"
  railway variable set "GITHUB_TOKEN=$GITHUB_UPDATER_TOKEN" --service updater --skip-deploys --json >>"$LOG" 2>&1 \
    || fail "Не смог задать GITHUB_TOKEN для updater." "$LOG"
  railway variable set "PROJECT_ID=$PROJECT_ID" --service updater --skip-deploys --json >>"$LOG" 2>&1 \
    || fail "Не смог задать PROJECT_ID для updater." "$LOG"
  railway variable set "SERVICES=$SERVICES_JSON" --service updater --skip-deploys --json >>"$LOG" 2>&1 \
    || fail "Не смог задать SERVICES для updater." "$LOG"

  echo "Деплою апдейтер (updater/ из sheets-mcp)..."
  deploy_fresh_code "updater" "$UPSTREAM_OWNER/sheets-mcp" "$PROJECT_ID" "updater"

  ok "Апдейтер настроен — раз в час сам проверяет и обновляет все 5 сервисов."
fi

cd /
rm -rf "$WORK_DIR"

# ── Готово ──────────────────────────────────────────────────────────────────
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
