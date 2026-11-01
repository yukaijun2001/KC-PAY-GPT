#!/bin/sh
set -eu

# HEADFUL 只影响浏览器启动；容器仍需要一个实际的 X display。
# Xvfb 提供虚拟显示，不提供可远程点击的桌面/VNC。
if [ "${XVFB_ENABLED:-1}" = "1" ] && [ -z "${DISPLAY:-}" ]; then
    exec xvfb-run -a -s '-screen 0 1920x1080x24 -nolisten tcp' "$@"
fi

exec "$@"
