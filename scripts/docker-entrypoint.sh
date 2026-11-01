#!/bin/sh
set -eu

# Xvfb 提供虚拟显示，不提供可远程点击的桌面/VNC。
# 不依赖 xvfb-run 的信号等待；显示服务失败时仍启动 Web，避免整个站点不可用。
start_xvfb() {
    for tool in Xvfb xauth xdpyinfo timeout node; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            echo "[启动] Xvfb 依赖缺失: $tool" >&2
            return 1
        fi
    done

    display_num=99
    while [ "$display_num" -le 199 ]; do
        if [ ! -e "/tmp/.X${display_num}-lock" ] && [ ! -e "/tmp/.X11-unix/X${display_num}" ]; then
            break
        fi
        display_num=$((display_num + 1))
    done
    if [ "$display_num" -gt 199 ]; then
        echo '[启动] 没有可用的 Xvfb 显示编号' >&2
        return 1
    fi

    display=:$display_num
    auth_dir=$(mktemp -d "${TMPDIR:-/tmp}/kc-xvfb.XXXXXXXX") || return 1
    auth_file=$auth_dir/Xauthority
    if ! : > "$auth_file" || ! chmod 600 "$auth_file"; then
        echo '[启动] 无法创建 Xvfb 授权文件' >&2
        rm -f "$auth_file" 2>/dev/null || :
        rmdir "$auth_dir" 2>/dev/null || :
        return 1
    fi
    cookie=$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))' 2>/dev/null) || cookie=
    if [ -z "$cookie" ] || ! printf 'add %s MIT-MAGIC-COOKIE-1 %s\n' "$display" "$cookie" | xauth -q -f "$auth_file" source -; then
        echo '[启动] 无法配置 Xvfb 授权' >&2
        unset cookie
        rm "$auth_file" 2>/dev/null || :
        rmdir "$auth_dir" 2>/dev/null || :
        return 1
    fi
    unset cookie

    # 让 Xvfb 以普通后台进程运行，不依赖其向父进程发送 SIGUSR1。
    Xvfb "$display" -screen 0 1920x1080x24 -nolisten tcp -auth "$auth_file" &
    xvfb_pid=$!

    timeout_seconds=${XVFB_START_TIMEOUT_SECONDS:-10}
    case "$timeout_seconds" in
        [1-9]|[1-9][0-9]|1[01][0-9]|120) ;;
        *) timeout_seconds=10 ;;
    esac
    echo "[启动] 等待 Xvfb ($display)，上限 ${timeout_seconds}s"
    deadline=$(( $(date +%s) + timeout_seconds ))
    while kill -0 "$xvfb_pid" 2>/dev/null; do
        if DISPLAY="$display" XAUTHORITY="$auth_file" timeout 1 xdpyinfo -display "$display" >/dev/null 2>&1; then
            DISPLAY=$display
            XAUTHORITY=$auth_file
            export DISPLAY XAUTHORITY
            echo "[启动] Xvfb 已就绪 ($DISPLAY)"
            return 0
        fi
        if [ "$(date +%s)" -ge "$deadline" ]; then break; fi
        sleep 0.1
    done

    echo "[启动] Xvfb 未就绪或已退出（等待上限 ${timeout_seconds}s）" >&2
    # 失败分支不能无限等待一个忽略 SIGTERM 的显示进程。
    kill -KILL "$xvfb_pid" 2>/dev/null || :
    wait "$xvfb_pid" 2>/dev/null || :
    rm "$auth_file" 2>/dev/null || :
    rmdir "$auth_dir" 2>/dev/null || :
    return 1
}

if [ "${XVFB_ENABLED:-1}" = "1" ] && [ -z "${DISPLAY:-}" ]; then
    if ! start_xvfb; then
        echo '[启动] 将继续启动 Web 服务；有头浏览器需要可用的 DISPLAY' >&2
    fi
fi

echo '[启动] 正在启动应用进程'
exec "$@"
