#!/bin/bash
# Free local engine for Subtitle Overlay on an Apple Silicon Mac. No API keys.
#   - Speech recognition: MegaASR (Qwen3-ASR based) served by mlx-audio on 127.0.0.1:8742, started at login.
#   - Translation: a Qwen model in Ollama (http://127.0.0.1:11434).
# Every step is safe to re-run: finished steps are skipped and downloads resume where they stopped.
#
# Usage: tools/setup-local.sh [all|install|download|service|status|uninstall]
set -uo pipefail

PORT="${SPEECH_PORT:-8742}"
SPEECH_MODEL="${SPEECH_MODEL:-mlx-community/Mega-ASR-bf16}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3:8b}"
LABEL="com.subtitle-overlay.speech-server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/SubtitleOverlay"
SERVER_BIN="$HOME/.local/bin/mlx_audio.server"
HF_BIN="$HOME/.local/share/uv/tools/mlx-audio/bin/hf"
HF_MODEL_DIR="$HOME/.cache/huggingface/hub/models--${SPEECH_MODEL//\//--}"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }

install_tools() {
  [ "$(uname -m)" = "arm64" ] || { log "This needs an Apple Silicon Mac (MLX)."; exit 1; }
  command -v uv >/dev/null || { log "uv is missing: install it from https://docs.astral.sh/uv/ and re-run."; exit 1; }
  command -v ollama >/dev/null || { log "Ollama is missing: install it from https://ollama.com/download and re-run."; exit 1; }
  if [ -x "$SERVER_BIN" ]; then
    log "mlx-audio already installed"
  else
    log "Installing mlx-audio (speech server)"
    uv tool install "mlx-audio[server]" --python 3.12
  fi
}

speech_model_ready() {
  ls "$HF_MODEL_DIR"/snapshots/*/model.safetensors >/dev/null 2>&1 &&
    ! ls "$HF_MODEL_DIR"/blobs/*.incomplete >/dev/null 2>&1
}

ollama_model_ready() {
  ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$OLLAMA_MODEL"
}

download_speech() {
  if speech_model_ready; then log "Speech model $SPEECH_MODEL already downloaded"; return; fi
  log "Downloading speech model $SPEECH_MODEL (about 4.2 GB)"
  # Plain HTTP downloads resume cleanly from the partial file after a stall or a restart.
  until HF_HUB_DISABLE_XET=1 HF_HUB_DOWNLOAD_TIMEOUT=60 "$HF_BIN" download "$SPEECH_MODEL" >/dev/null; do
    log "Speech model download interrupted; retrying in 30 s"
    sleep 30
  done
  log "Speech model ready"
}

download_translator() {
  if ollama_model_ready; then log "Ollama model $OLLAMA_MODEL already downloaded"; return; fi
  log "Pulling translation model $OLLAMA_MODEL with Ollama"
  until ollama pull "$OLLAMA_MODEL"; do
    log "Ollama pull interrupted; retrying in 30 s"
    sleep 30
  done
  log "Translation model ready"
}

download_models() {
  download_speech &
  local a=$!
  download_translator &
  local b=$!
  wait "$a" "$b"
  log "All downloads finished"
}

install_service() {
  mkdir -p "$LOG_DIR/server-logs" "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$SERVER_BIN</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>$PORT</string>
    <string>--log-dir</string><string>$LOG_DIR/server-logs</string>
  </array>
  <key>WorkingDirectory</key><string>$LOG_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HF_HUB_OFFLINE</key><string>1</string>
    <key>PYTHONWARNINGS</key><string>ignore</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG_DIR/speech-server.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/speech-server.log</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" && log "Speech server installed as a login item on http://127.0.0.1:$PORT"
}

status() {
  if curl -s -m 3 "http://127.0.0.1:$PORT/v1/models" >/dev/null; then echo "Speech server:     running on 127.0.0.1:$PORT"; else echo "Speech server:     NOT running (tools/setup-local.sh service)"; fi
  if speech_model_ready; then
    echo "Speech model:      $SPEECH_MODEL downloaded"
  else
    local part
    part=$(ls -l "$HF_MODEL_DIR"/blobs/*.incomplete 2>/dev/null | awk '{s+=$5} END {printf "%.2f", s/1e9}')
    echo "Speech model:      downloading, ${part:-0.00} GB of about 4.2 GB"
  fi
  if curl -s -m 3 http://127.0.0.1:11434/api/version >/dev/null; then echo "Ollama:            running"; else echo "Ollama:            NOT running (open the Ollama app)"; fi
  if ollama_model_ready; then echo "Translation model: $OLLAMA_MODEL downloaded"; else echo "Translation model: $OLLAMA_MODEL not downloaded yet"; fi
}

uninstall_service() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  log "Speech server login item removed. Models stay on disk: delete $HF_MODEL_DIR and run 'ollama rm $OLLAMA_MODEL' to free the space."
}

case "${1:-all}" in
  all) install_tools && install_service && download_models && status ;;
  install) install_tools ;;
  download) download_models ;;
  service) install_service ;;
  status) status ;;
  uninstall) uninstall_service ;;
  *) echo "Usage: $0 [all|install|download|service|status|uninstall]"; exit 2 ;;
esac
