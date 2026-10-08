#!/bin/sh
# Подмена CLI claude для тестов аккаунтов: auth status, login, logout и короткий запуск -p.
# Каждый вызов дописывает в $FAKE_AUTH_LOG аргументы, CLAUDE_CONFIG_DIR и видны ли переменные родительской сессии.
echo "$* | dir=${CLAUDE_CONFIG_DIR:-} | parent=${CLAUDE_TEST_PARENT:-} | oauth=${CLAUDE_CODE_OAUTH_TOKEN:+set}" >> "$FAKE_AUTH_LOG"
case "$1 $2" in
  "auth status")
    if [ -n "$CLAUDE_CONFIG_DIR" ] && [ ! -f "$CLAUDE_CONFIG_DIR/logged" ]; then
      echo '{"loggedIn":false,"authMethod":"none"}'; exit 1
    fi
    echo '{"loggedIn":true,"authMethod":"claude.ai","email":"second@example.org","orgName":"Вторая","subscriptionType":"max"}' ;;
  "auth login")
    echo "Opening browser to sign in…"
    echo "If the browser didn't open, visit: https://claude.example.org/oauth/authorize?code=true&state=x"
    printf "Paste code here if prompted > "
    read code
    [ "$code" = "good-code" ] || { echo "Invalid code"; exit 1; }
    touch "$CLAUDE_CONFIG_DIR/logged"; echo "Login successful." ;;
  "auth logout")
    rm -f "$CLAUDE_CONFIG_DIR/logged" ;;
  *)
    if [ "$CLAUDE_CODE_OAUTH_TOKEN" = "sk-ant-oat01-rejected-token" ]; then
      echo '{"type":"result","is_error":true,"result":"Invalid bearer token"}'; exit 1
    fi
    echo '{"type":"result","is_error":false,"result":"ok"}' ;;
esac
