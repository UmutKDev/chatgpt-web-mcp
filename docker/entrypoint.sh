#!/bin/sh
set -e
# Start a virtual X display when running Chromium headful (the default).
case "$(printf %s "${HEADLESS:-false}" | tr 'A-Z' 'a-z')" in
  1|true|yes|on) ;;
  *)
    if [ -z "${CHATGPT_CDP_URL:-}" ]; then
      rm -f /tmp/.X99-lock
      Xvfb "${DISPLAY:-:99}" -screen 0 1440x1000x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
      sleep 0.5
    fi
    ;;
esac
exec "$@"
