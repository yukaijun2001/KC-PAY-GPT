#!/usr/bin/env bash
# Rebuild and replace this Compose project from the configured Git remote.
# Persistent data and unrelated Docker projects are intentionally left alone.
set -Eeuo pipefail
umask 077

if [[ -z "${KC_DEPLOY_INTERNAL:-}" ]]; then
    project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
    temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/kc-pay-deploy.XXXXXXXX")
    cp -- "${BASH_SOURCE[0]}" "$temp_dir/deploy.sh"
    export KC_DEPLOY_INTERNAL=1 KC_DEPLOY_PROJECT_DIR="$project_dir" KC_DEPLOY_TEMP="$temp_dir"
    exec bash "$temp_dir/deploy.sh" "$@"
fi

ROOT=$KC_DEPLOY_PROJECT_DIR
TEMP=$KC_DEPLOY_TEMP
STAGE="$TEMP/source"
REMOTE=${DEPLOY_REMOTE:-origin}
BRANCH=${DEPLOY_BRANCH:-main}
HEALTH_TIMEOUT=${DEPLOY_HEALTH_TIMEOUT:-240}
PROJECT_NAME='' OLD_APP_IMAGE='' NEW_APP_IMAGE='' OLD_MYSQL_IMAGE=''
STAGE_IMAGE='' BACKUP_IMAGE='' OLD_COMMIT='' TARGET_COMMIT=''
STASH_COMMIT='' BACKUP_REF='' LOCK_DIR=''
SWITCH_STARTED=0 CHECKOUT_ATTEMPTED=0 BACKUP_TAGGED=0
OLD_APP_RUNNING=0 OLD_MYSQL_RUNNING=0 DEPLOY_SUCCEEDED=0

log() { printf '[部署] %s\n' "$*"; }
die() { printf '[部署] 错误：%s\n' "$*" >&2; exit 1; }
git_repo() { git -c "safe.directory=$ROOT" -C "$ROOT" "$@"; }
compose_root() { docker compose -p "$PROJECT_NAME" --project-directory "$ROOT" -f "$ROOT/docker-compose.yml" "$@"; }
compose_stage() {
    if [[ -f "$ROOT/.env" ]]; then
        docker compose -p "$PROJECT_NAME" --project-directory "$STAGE" --env-file "$ROOT/.env" -f "$STAGE/docker-compose.yml" "$@"
    else
        docker compose -p "$PROJECT_NAME" --project-directory "$STAGE" -f "$STAGE/docker-compose.yml" "$@"
    fi
}

rollback() {
    set +e
    log '部署失败，正在尝试恢复原代码、镜像和原有服务……'
    if (( CHECKOUT_ATTEMPTED )); then
        compose_root down --remove-orphans >/dev/null 2>&1 || true
        git_repo reset --hard "$OLD_COMMIT" >/dev/null || true
    fi
    if [[ -n "$STASH_COMMIT" ]]; then
        if git_repo stash apply --index "$STASH_COMMIT" >/dev/null; then
            log "已恢复本地未提交改动；备份仍保留在 Git stash：$STASH_COMMIT"
        else
            log "未能自动恢复本地改动，请检查 Git stash：$STASH_COMMIT"
        fi
    fi
    if (( BACKUP_TAGGED )); then
        docker image tag "$BACKUP_IMAGE" "$OLD_APP_IMAGE" || true
    fi
    if (( OLD_APP_RUNNING )); then
        compose_root up -d --no-build || log '原服务未能自动恢复，请检查 docker compose logs。'
    elif (( OLD_MYSQL_RUNNING )); then
        compose_root up -d --no-build mysql || log 'MySQL 容器未能自动恢复，请检查 docker compose logs。'
    fi
    if (( BACKUP_TAGGED )); then
        log "原应用镜像备份保留为：$BACKUP_IMAGE"
    fi
}

cleanup() {
    local status=$?
    trap - EXIT INT TERM
    if (( status != 0 && SWITCH_STARTED )); then rollback; fi
    if [[ -n "$STAGE_IMAGE" ]]; then docker image rm "$STAGE_IMAGE" >/dev/null 2>&1 || true; fi
    if (( DEPLOY_SUCCEEDED && BACKUP_TAGGED )); then
        docker image rm "$BACKUP_IMAGE" >/dev/null 2>&1 || log "旧镜像备份仍保留：$BACKUP_IMAGE"
    fi
    if [[ -n "$LOCK_DIR" ]]; then rmdir "$LOCK_DIR" 2>/dev/null || true; fi
    if [[ -n "$TEMP" && -d "$TEMP" ]]; then rm -rf -- "$TEMP"; fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ $# -eq 0 ]] || die '不需要位置参数；可通过 DEPLOY_REMOTE、DEPLOY_BRANCH 和 DEPLOY_HEALTH_TIMEOUT 配置。'
[[ "$HEALTH_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || die 'DEPLOY_HEALTH_TIMEOUT 必须是正整数。'
for tool in git docker python3 tar; do command -v "$tool" >/dev/null 2>&1 || die "缺少命令：$tool"; done
docker compose version >/dev/null 2>&1 || die '未安装 Docker Compose 插件。'
docker info >/dev/null 2>&1 || die '无法访问 Docker，请使用 sudo bash ./deploy.sh 或检查 Docker 服务。'
[[ -w "$ROOT" ]] || die '项目目录不可写，请使用 sudo bash ./deploy.sh。'
git_repo rev-parse --is-inside-work-tree >/dev/null 2>&1 || die '脚本必须位于现有 Git 项目根目录。'
[[ "$(git_repo rev-parse --show-toplevel)" == "$ROOT" ]] || die '脚本必须位于 Git 项目根目录。'
git_repo check-ref-format --branch "$BRANCH" >/dev/null 2>&1 || die 'DEPLOY_BRANCH 不是有效分支名。'
[[ "$(git_repo branch --show-current)" == "$BRANCH" ]] || die "当前分支不是 ${BRANCH}，请先切换到目标分支。"
git_repo remote get-url "$REMOTE" >/dev/null 2>&1 || die "Git 远程不存在：$REMOTE"
[[ -f "$ROOT/docker-compose.yml" ]] || die '项目根目录缺少 docker-compose.yml。'
[[ -z "${COMPOSE_FILE:-}" && -z "${COMPOSE_ENV_FILES:-}" ]] || die '暂不支持自定义 COMPOSE_FILE 或 COMPOSE_ENV_FILES，请先确认实际部署配置。'
for override in docker-compose.override.yml docker-compose.override.yaml compose.override.yml compose.override.yaml; do
    [[ ! -f "$ROOT/$override" ]] || die "检测到自定义覆盖文件 ${override}；为避免忽略现有配置已停止部署。"
done
if [[ -f "$ROOT/.env" ]] && python3 - "$ROOT/.env" <<'PY'
import re, sys
with open(sys.argv[1], encoding='utf-8') as f:
    found = any(re.match(r'^\s*(?:export\s+)?COMPOSE_(?:FILE|ENV_FILES)\s*=', line) for line in f)
raise SystemExit(0 if found else 1)
PY
then
    die '.env 包含自定义 COMPOSE_FILE 或 COMPOSE_ENV_FILES；为避免忽略现有配置已停止部署。'
fi

lock_key=$(printf '%s' "$ROOT" | cksum | awk '{print $1}')
LOCK_DIR="${TMPDIR:-/tmp}/kc-pay-deploy-${lock_key}.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    existing_lock=$LOCK_DIR
    LOCK_DIR=''
    die "已有部署在进行，或上次部署遗留了锁目录：$existing_lock"
fi

# Extract only non-sensitive metadata; do not print interpolated environment values.
read_compose_metadata() {
    python3 -c '
import json, sys
d = json.load(sys.stdin)
name = d["name"]
app = d["services"]["app"]
mysql = d["services"]["mysql"]
mount = next((x for x in mysql.get("volumes", []) if x.get("target") == "/var/lib/mysql"), None)
if not mount or not mysql.get("image"):
    raise SystemExit("MySQL image or data mount is missing")
source = mount.get("source", "")
if mount.get("type") == "volume":
    source = d.get("volumes", {}).get(source, {}).get("name", source)
print(name)
print(app.get("image") or (name + "-app"))
print(mysql["image"])
print(mount.get("type", "") + ":" + source)
'
}

config_fingerprint() {
    python3 - "$ROOT" <<'PY'
import hashlib, os, sys
root = sys.argv[1]
digest = hashlib.sha256()
for name in ('.env', 'docker-compose.yml', 'docker-compose.override.yml',
             'docker-compose.override.yaml', 'compose.override.yml', 'compose.override.yaml'):
    path = os.path.join(root, name)
    digest.update(name.encode() + b'\0')
    if os.path.isfile(path):
        with open(path, 'rb') as f:
            digest.update(b'file\0' + f.read())
    else:
        digest.update(b'missing\0')
print(digest.hexdigest())
PY
}

initial_config_fingerprint=$(config_fingerprint)
old_meta=$(docker compose --project-directory "$ROOT" -f "$ROOT/docker-compose.yml" config --format json | read_compose_metadata)
PROJECT_NAME=$(printf '%s\n' "$old_meta" | sed -n '1p')
OLD_APP_IMAGE=$(printf '%s\n' "$old_meta" | sed -n '2p')
OLD_MYSQL_IMAGE=$(printf '%s\n' "$old_meta" | sed -n '3p')
old_mysql_mount=$(printf '%s\n' "$old_meta" | sed -n '4p')
[[ -n "$PROJECT_NAME" && -n "$OLD_APP_IMAGE" && -n "$OLD_MYSQL_IMAGE" && -n "$old_mysql_mount" ]] || die '无法解析当前 Compose 配置。'

OLD_COMMIT=$(git_repo rev-parse HEAD)
log "正在从 $REMOTE/$BRANCH 获取最新代码（现有服务保持运行）……"
GIT_TERMINAL_PROMPT=0 git_repo fetch --no-tags "$REMOTE" "refs/heads/$BRANCH"
TARGET_COMMIT=$(git_repo rev-parse 'FETCH_HEAD^{commit}')

# Never overwrite runtime data tracked accidentally in either version.
check_tracked_runtime() {
    python3 -c '
import sys
for raw in sys.stdin:
    p = raw.strip()
    if ((p == ".env" or (p.startswith(".env.") and p != ".env.example"))
        or p.startswith(("node_modules/", "debug_screenshots/", "product_files/"))
        or (p.startswith("data/") and p != "data/.gitkeep")):
        raise SystemExit("Git 跟踪了运行数据或环境配置，已停止以保护现有文件：" + p)
'
}
git_repo ls-files | check_tracked_runtime
git_repo ls-tree -r --name-only "$TARGET_COMMIT" | check_tracked_runtime

mkdir "$STAGE"
git_repo archive "$TARGET_COMMIT" | tar -x -C "$STAGE"
[[ -f "$STAGE/docker-compose.yml" && -f "$STAGE/Dockerfile" && -f "$STAGE/server.js" ]] || die '远程代码缺少部署所需文件。'
[[ -f "$STAGE/deploy.sh" ]] || die '远程分支尚未包含 deploy.sh，请先将脚本推送到远程仓库。'

new_meta=$(compose_stage config --format json | read_compose_metadata)
NEW_APP_IMAGE=$(printf '%s\n' "$new_meta" | sed -n '2p')
new_mysql_image=$(printf '%s\n' "$new_meta" | sed -n '3p')
new_mysql_mount=$(printf '%s\n' "$new_meta" | sed -n '4p')
[[ "$old_mysql_mount" == "$new_mysql_mount" ]] || die '新旧 MySQL 数据卷不一致；为保护数据已停止部署。'
[[ "$OLD_MYSQL_IMAGE" == "$new_mysql_image" ]] || die '新旧 MySQL 镜像配置不同；为避免自动升级数据库已停止部署。'

old_app_id=$(compose_root ps --all --quiet app)
old_mysql_id=$(compose_root ps --all --quiet mysql)
# A missing or changed .env must not silently replace working DB credentials.
# Compare in memory and report variable names only, never their values.
python3 - "$ROOT" "$STAGE" "$PROJECT_NAME" "$old_app_id" "$old_mysql_id" "$old_mysql_mount" <<'PY'
import json, os, subprocess, sys
root, stage, project, app_id, mysql_id, expected_mount = sys.argv[1:]
def compose(directory):
    command = ['docker', 'compose', '-p', project, '--project-directory', directory]
    env_file = os.path.join(root, '.env')
    if os.path.isfile(env_file):
        command.extend(['--env-file', env_file])
    command.extend(['-f', os.path.join(directory, 'docker-compose.yml'), 'config', '--format', 'json'])
    return json.loads(subprocess.check_output(command))
configs = [('当前配置', compose(root)), ('新配置', compose(stage))]
for service, container, keys in [
    ('app', app_id, ('DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME')),
    ('mysql', mysql_id, ('MYSQL_ROOT_PASSWORD', 'MYSQL_DATABASE'))
]:
    if not container:
        continue
    inspected = json.loads(subprocess.check_output(['docker', 'inspect', container]))[0]
    if service == 'mysql':
        mount = next((item for item in inspected.get('Mounts', []) if item.get('Destination') == '/var/lib/mysql'), None)
        actual = '' if not mount else mount.get('Type', '') + ':' + (mount.get('Name', '') if mount.get('Type') == 'volume' else mount.get('Source', ''))
        if actual != expected_mount:
            raise SystemExit('现有 MySQL 容器的数据挂载与 Compose 配置不一致；已停止部署')
    live = dict(item.split('=', 1) for item in inspected.get('Config', {}).get('Env', []) if '=' in item)
    for label, config in configs:
        expected = config['services'][service].get('environment', {}) or {}
        different = [key for key in keys if key in expected and live.get(key, '') != str(expected[key] or '')]
        if different:
            raise SystemExit(f'{label}与现有 {service} 容器的数据库配置不一致：{", ".join(different)}；已停止部署')
PY
old_app_image_id=''
if [[ -n "$old_app_id" ]]; then
    old_app_image_id=$(docker inspect --format '{{.Image}}' "$old_app_id")
    tagged_app_id=$(docker image inspect --format '{{.Id}}' "$OLD_APP_IMAGE" 2>/dev/null || true)
    [[ -z "$tagged_app_id" || "$tagged_app_id" == "$old_app_image_id" ]] || die '应用当前容器与镜像标签不一致，请先检查已有部署。'
    [[ "$(docker inspect --format '{{.State.Running}}' "$old_app_id")" == true ]] && OLD_APP_RUNNING=1
elif docker image inspect "$OLD_APP_IMAGE" >/dev/null 2>&1; then
    old_app_image_id=$(docker image inspect --format '{{.Id}}' "$OLD_APP_IMAGE")
fi
if [[ -n "$old_mysql_id" ]]; then
    [[ "$(docker inspect --format '{{.State.Running}}' "$old_mysql_id")" == true ]] && OLD_MYSQL_RUNNING=1
    current_mysql_id=$(docker inspect --format '{{.Image}}' "$old_mysql_id")
    tagged_mysql_id=$(docker image inspect --format '{{.Id}}' "$OLD_MYSQL_IMAGE" 2>/dev/null || true)
    [[ "$current_mysql_id" == "$tagged_mysql_id" ]] || die 'MySQL 当前容器与镜像标签不一致；为避免数据库版本变化已停止部署。'
elif ! docker image inspect "$OLD_MYSQL_IMAGE" >/dev/null 2>&1; then
    log '本地缺少 MySQL 镜像，正在预先拉取……'
    compose_stage pull mysql
fi

STAGE_IMAGE="${PROJECT_NAME}-deploy:stage-$(date +%s)-$$"
BACKUP_IMAGE="${PROJECT_NAME}-deploy:backup-$(date +%s)-$$"
cat > "$TEMP/build-override.yml" <<EOF
services:
  app:
    image: $STAGE_IMAGE
EOF
log '正在隔离构建新应用镜像；构建失败不会中断现有服务……'
compose_stage -f "$TEMP/build-override.yml" build app

# Builds can take minutes; abort before downtime if another operator changed
# the running stack or its configuration while the new image was building.
[[ "$(config_fingerprint)" == "$initial_config_fingerprint" ]] || die '配置文件在构建期间发生变化；未停止现有服务。'
[[ "$(git_repo rev-parse HEAD)" == "$OLD_COMMIT" && "$(git_repo branch --show-current)" == "$BRANCH" ]] || die 'Git 分支或提交在构建期间发生变化；未停止现有服务。'
[[ "$(compose_root ps --all --quiet app)" == "$old_app_id" && "$(compose_root ps --all --quiet mysql)" == "$old_mysql_id" ]] || die '运行容器在构建期间发生变化；未停止现有服务。'
if [[ -n "$old_mysql_id" ]]; then
    [[ "$(docker image inspect --format '{{.Id}}' "$OLD_MYSQL_IMAGE" 2>/dev/null || true)" == "$current_mysql_id" ]] || die 'MySQL 镜像标签在构建期间发生变化；未停止现有服务。'
fi
if [[ -n "$old_app_id" && -n "${tagged_app_id:-}" ]]; then
    [[ "$(docker image inspect --format '{{.Id}}' "$OLD_APP_IMAGE" 2>/dev/null || true)" == "$old_app_image_id" ]] || die '应用镜像标签在构建期间发生变化；未停止现有服务。'
fi

if [[ -n "$old_app_image_id" ]]; then
    docker image tag "$old_app_image_id" "$BACKUP_IMAGE"
    BACKUP_TAGGED=1
fi
if [[ "$OLD_COMMIT" != "$TARGET_COMMIT" ]]; then
    BACKUP_REF="refs/kc-deploy-backups/$(date +%s)-$$"
    git_repo update-ref "$BACKUP_REF" "$OLD_COMMIT"
fi

log '停止并移除本项目的旧容器（保留 MySQL 数据卷）……'
SWITCH_STARTED=1
compose_root down --remove-orphans
# Do not use `down --rmi local`: Compose can also remove the freshly built
# staging image because it belongs to the same project.
if [[ -n "$old_app_image_id" ]] && docker image inspect "$OLD_APP_IMAGE" >/dev/null 2>&1; then
    if [[ -n "$(docker ps --all --quiet --filter "ancestor=$old_app_image_id")" ]]; then
        log '旧应用镜像仍被其他容器使用，保留其镜像标签。'
    else
        docker image rm "$OLD_APP_IMAGE" >/dev/null || log '旧应用镜像未能移除，将继续使用新镜像。'
    fi
fi

if [[ -n "$(git_repo status --porcelain --untracked-files=all)" ]]; then
    log '检测到本地未提交文件，先备份到 Git stash。'
    git_repo -c user.name='KC Deploy Backup' -c user.email='kc-deploy@localhost' \
        stash push --include-untracked -m "kc-deploy-$(date +%Y%m%d-%H%M%S)"
    STASH_COMMIT=$(git_repo rev-parse refs/stash)
fi

CHECKOUT_ATTEMPTED=1
git_repo reset --hard "$TARGET_COMMIT"
docker image tag "$STAGE_IMAGE" "$NEW_APP_IMAGE"
log '正在启动新容器……'
compose_root up -d --no-build

app_id=$(compose_root ps --quiet app)
[[ -n "$app_id" ]] || die '应用容器未启动。'
deadline=$((SECONDS + HEALTH_TIMEOUT))
while (( SECONDS < deadline )); do
    state=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$app_id" 2>/dev/null || true)
    case "$state" in
        healthy) break ;;
        unhealthy|exited|dead) compose_root logs --tail=80 app || true; die "应用状态异常：$state" ;;
    esac
    sleep 3
done
[[ "${state:-}" == healthy ]] || { compose_root logs --tail=80 app || true; die "应用健康检查超时（${HEALTH_TIMEOUT}s）。"; }

DEPLOY_SUCCEEDED=1
log "部署完成：$(git_repo rev-parse --short HEAD)；应用健康检查通过。"
[[ -z "$STASH_COMMIT" ]] || log "本地改动已备份，未应用到新代码；可通过 git stash list 查看：$STASH_COMMIT"
[[ -z "$BACKUP_REF" ]] || log "旧版本备份引用：$BACKUP_REF"
compose_root ps
