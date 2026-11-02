#!/usr/bin/env bash
# Optional integration test: creates only a uniquely named temporary Compose
# project and its own disposable MySQL volume; never targets the real project.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
TEMP=$(mktemp -d "${TMPDIR:-/tmp}/kc-deploy-docker-test.XXXXXXXX")
PROJECT="kcdeploytest$(date +%s)$$"
WORK="$TEMP/work"
REMOTE="$TEMP/remote.git"
UPDATE="$TEMP/update"

compose() { docker compose -p "$PROJECT" --project-directory "$WORK" -f "$WORK/docker-compose.yml" "$@"; }
cleanup() {
    if [[ -f "$WORK/docker-compose.yml" ]]; then
        compose down --volumes --remove-orphans --rmi local >/dev/null 2>&1 || true
    fi
    rm -rf -- "$TEMP"
}
trap cleanup EXIT

for tool in git docker python3 tar; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
docker info >/dev/null
mkdir "$WORK"
git init --bare --initial-branch=main "$REMOTE" >/dev/null
git -C "$WORK" init --initial-branch=main >/dev/null
git -C "$WORK" config user.name 'Deploy Test'
git -C "$WORK" config user.email 'deploy-test@example.invalid'
cp "$ROOT/deploy.sh" "$WORK/deploy.sh"
printf '.env\ndata/*\n!data/.gitkeep\n' > "$WORK/.gitignore"
mkdir "$WORK/data"
: > "$WORK/data/.gitkeep"
printf 'original\n' > "$WORK/local.txt"
cat > "$WORK/Dockerfile" <<'EOF'
FROM node:20-slim
WORKDIR /app
COPY . /app
HEALTHCHECK --interval=2s --timeout=2s --start-period=2s --retries=5 CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
EOF
printf "require('http').createServer((q,r)=>r.end('old')).listen(3000,'0.0.0.0');\n" > "$WORK/server.js"
cat > "$WORK/docker-compose.yml" <<'EOF'
services:
  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: ${DB_PASSWORD}
      MYSQL_DATABASE: plus_papay
    volumes:
      - mysql_data:/var/lib/mysql
    healthcheck:
      test: ["CMD-SHELL", "MYSQL_PWD=\"$$MYSQL_ROOT_PASSWORD\" mysqladmin ping -h 127.0.0.1 -uroot --silent"]
      interval: 2s
      timeout: 2s
      retries: 30
  app:
    build: .
    environment:
      DB_HOST: mysql
      DB_PORT: '3306'
      DB_USER: root
      DB_PASSWORD: ${DB_PASSWORD}
      DB_NAME: plus_papay
    depends_on:
      mysql:
        condition: service_healthy
volumes:
  mysql_data:
EOF
git -C "$WORK" add .
git -C "$WORK" commit -m old >/dev/null
git -C "$WORK" remote add origin "$REMOTE"
git -C "$WORK" push -u origin main >/dev/null 2>&1
printf 'DB_PASSWORD=temporary-test-only\n' > "$WORK/.env"
printf 'runtime-kept\n' > "$WORK/data/runtime.txt"
echo 'Starting an isolated temporary Compose project...'
compose up -d --build > "$TEMP/start.log" 2>&1 || { tail -60 "$TEMP/start.log"; exit 1; }
compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot plus_papay -e "CREATE TABLE deploy_test (v VARCHAR(20)); INSERT INTO deploy_test VALUES (\"preserved\");"'

git clone "$REMOTE" "$UPDATE" >/dev/null 2>&1
git -C "$UPDATE" config user.name 'Deploy Test'
git -C "$UPDATE" config user.email 'deploy-test@example.invalid'
printf "require('http').createServer((q,r)=>r.end('new')).listen(3000,'0.0.0.0');\n" > "$UPDATE/server.js"
# The staged build must never contain the original working-tree .env.
printf '\nRUN test ! -e /app/.env\n' >> "$UPDATE/Dockerfile"
git -C "$UPDATE" add server.js Dockerfile
git -C "$UPDATE" commit -m new >/dev/null
git -C "$UPDATE" push origin main >/dev/null 2>&1
printf 'local-changes\n' > "$WORK/local.txt"
printf 'untracked-note\n' > "$WORK/notes.txt"

echo 'Running the actual deploy script against the temporary project...'
(cd "$WORK" && COMPOSE_PROJECT_NAME="$PROJECT" DEPLOY_HEALTH_TIMEOUT=60 bash ./deploy.sh) > "$TEMP/deploy.log" 2>&1 || { tail -90 "$TEMP/deploy.log"; exit 1; }
app=$(compose exec -T app node -e "fetch('http://127.0.0.1:3000/').then(r=>r.text()).then(console.log)")
db=$(compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -N -uroot plus_papay -e "SELECT v FROM deploy_test"' | tr -d '\r')
[[ "$app" == new && "$db" == preserved && "$(cat "$WORK/data/runtime.txt")" == runtime-kept ]]
[[ "$(git -C "$WORK" show 'stash@{0}:local.txt')" == local-changes ]]
[[ "$(git -C "$WORK" show 'stash@{0}^3:notes.txt')" == untracked-note ]]
[[ "$(cat "$WORK/.env")" == 'DB_PASSWORD=temporary-test-only' ]]
echo 'PASS: new app, MySQL volume, runtime files, .env isolation and local-change backup.'
