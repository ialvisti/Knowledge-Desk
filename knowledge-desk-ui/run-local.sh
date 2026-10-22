#!/usr/bin/env bash
# Levanta el backend RAG y la interfaz de Knowledge Desk para probar en local.
# Ctrl+C detiene los dos procesos.
set -euo pipefail

UI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# El backend no forma parte de este proyecto: vive en kb-rag-system de ForUsGuide.
if [ -z "${KNOWLEDGE_API_DIR:-}" ]; then
  echo "Define KNOWLEDGE_API_DIR con la ruta a kb-rag-system de un checkout de ForUsGuide," >&2
  echo "o arranca el backend por tu cuenta y usa npm run dev." >&2
  exit 1
fi
API_DIR="$(cd "$KNOWLEDGE_API_DIR" && pwd)"
API_HOST="${KNOWLEDGE_API_HOST:-127.0.0.1}"
API_PORT="${KNOWLEDGE_API_PORT:-8000}"
UI_PORT="${KNOWLEDGE_UI_PORT:-5173}"
PYTHON="${KNOWLEDGE_API_PYTHON:-$API_DIR/venv/bin/python}"

if [ ! -x "$PYTHON" ]; then
  echo "No encuentro el intérprete del backend en $PYTHON" >&2
  echo "Indica otro con KNOWLEDGE_API_PYTHON=/ruta/al/python" >&2
  exit 1
fi
if [ ! -f "$API_DIR/.env" ]; then
  echo "No encuentro $API_DIR/.env; el backend necesita sus credenciales" >&2
  exit 1
fi

health_body() { curl -sf --max-time 5 "http://$API_HOST:$API_PORT/health" 2>/dev/null; }
# /health responde 200 tambien cuando el backend arranco sin Pinecone o sin
# proveedor de modelo. En ese estado la consulta falla, asi que se avisa.
warn_if_degraded() {
  local body
  body="$(health_body)" || return 0
  case "$body" in
    *'"status"'*'"healthy"'*) return 0 ;;
    *) echo "Aviso: el backend responde pero no esta sano: $body" >&2 ;;
  esac
}

api_pid=""
cleanup() {
  if [ -n "$api_pid" ] && kill -0 "$api_pid" 2>/dev/null; then
    kill "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if health_body > /dev/null; then
  echo "Backend ya en marcha en http://$API_HOST:$API_PORT"
  warn_if_degraded
else
  echo "Arrancando el backend RAG en http://$API_HOST:$API_PORT ..."
  # El .env local deja FORUSBOTS_MAX_WAIT_S igual al presupuesto de inquiry y la
  # validación de arranque lo rechaza. El valor sólo afecta al manejo de tickets,
  # que esta interfaz no usa, así que se baja aquí en lugar de tocar el .env.
  (
    cd "$API_DIR"
    FORUSBOTS_MAX_WAIT_S="${FORUSBOTS_MAX_WAIT_S:-240}" \
      exec "$PYTHON" -m uvicorn api.main:app --host "$API_HOST" --port "$API_PORT"
  ) &
  api_pid=$!

  echo -n "Esperando a que el backend responda"
  for _ in $(seq 1 60); do
    if health_body > /dev/null; then
      echo " listo."
      break
    fi
    if ! kill -0 "$api_pid" 2>/dev/null; then
      echo
      echo "El backend terminó durante el arranque. Revisa el log de arriba." >&2
      exit 1
    fi
    echo -n "."
    sleep 1
  done
  if ! health_body > /dev/null; then
    echo
    echo "El backend no respondió a tiempo en http://$API_HOST:$API_PORT/health" >&2
    exit 1
  fi
  warn_if_degraded
fi

cd "$UI_DIR"
[ -d node_modules ] || npm ci
echo "Interfaz en http://127.0.0.1:$UI_PORT"
KNOWLEDGE_API_TARGET="http://$API_HOST:$API_PORT" \
  npm run dev -- --host 127.0.0.1 --port "$UI_PORT" --strictPort
