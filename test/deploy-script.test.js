'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const deployScript = path.join(__dirname, '..', 'deploy.sh');
let scratch;

function git(cwd, ...args) {
    return execFileSync('git', args, {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    }).trim();
}

function write(file, contents, mode) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, mode ? { mode } : undefined);
}

function fixture() {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-deploy-test-'));
    const project = path.join(scratch, 'project');
    const remote = path.join(scratch, 'remote.git');
    const update = path.join(scratch, 'update');
    const bin = path.join(scratch, 'bin');
    const log = path.join(scratch, 'docker.log');
    const once = path.join(scratch, 'failed-once');
    fs.mkdirSync(project);
    fs.mkdirSync(bin);
    git(scratch, 'init', '--bare', '--initial-branch=main', remote);
    git(project, 'init', '--initial-branch=main');
    git(project, 'config', 'user.name', 'Test');
    git(project, 'config', 'user.email', 'test@example.invalid');
    write(path.join(project, '.gitignore'), '.env\ndata/*\n!data/.gitkeep\ndebug_screenshots/\nproduct_files/\n');
    write(path.join(project, 'data', '.gitkeep'), '');
    write(path.join(project, 'server.js'), 'old server\n');
    write(path.join(project, 'local.txt'), 'old local\n');
    write(path.join(project, 'Dockerfile'), 'FROM node:20-slim\n');
    write(path.join(project, 'docker-compose.yml'), 'name: kc-gpt-pay2\nservices: {}\n');
    fs.copyFileSync(deployScript, path.join(project, 'deploy.sh'));
    fs.chmodSync(path.join(project, 'deploy.sh'), 0o755);
    git(project, 'add', '.');
    git(project, 'commit', '-m', 'old');
    const oldCommit = git(project, 'rev-parse', 'HEAD');
    git(project, 'remote', 'add', 'origin', remote);
    git(project, 'push', '-u', 'origin', 'main');

    git(scratch, 'clone', remote, update);
    git(update, 'config', 'user.name', 'Test');
    git(update, 'config', 'user.email', 'test@example.invalid');
    write(path.join(update, 'server.js'), 'new server\n');
    git(update, 'add', 'server.js');
    git(update, 'commit', '-m', 'new');
    const newCommit = git(update, 'rev-parse', 'HEAD');
    git(update, 'push', 'origin', 'main');

    write(path.join(project, '.env'), 'PORT=28080\nSECRET=kept-private\n');
    write(path.join(project, 'data', 'runtime.json'), 'persistent data');
    write(path.join(project, 'debug_screenshots', 'image.png'), 'image');
    write(path.join(project, 'product_files', 'product.txt'), 'product');
    write(path.join(project, 'local.txt'), 'user local modification\n');
    write(path.join(project, 'notes.txt'), 'user untracked note\n');

    const fakeDocker = `#!/bin/bash
set -u
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [[ "\${1:-}" == info ]]; then exit 0; fi
if [[ "\${1:-}" == ps ]]; then
  [[ "\${DOCKER_OTHER_CONTAINER:-0}" != 1 ]] || echo other-container
  exit 0
fi
if [[ "\${1:-}" == compose ]]; then
  shift
  project_dir=''
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project-directory) project_dir="$2"; shift 2 ;;
      -p|--env-file|-f) shift 2 ;;
      *) break ;;
    esac
  done
  cmd="\${1:-}"; shift || :
  case "$cmd" in
    version) exit 0 ;;
    config) printf '%s\\n' '{"name":"kc-gpt-pay2","services":{"app":{"environment":{"DB_HOST":"mysql","DB_PORT":"3306","DB_USER":"root","DB_PASSWORD":"dummysecret","DB_NAME":"plus_papay"}},"mysql":{"image":"mysql:8.0","environment":{"MYSQL_ROOT_PASSWORD":"dummysecret","MYSQL_DATABASE":"plus_papay"},"volumes":[{"type":"volume","source":"mysql_data","target":"/var/lib/mysql"}]}},"volumes":{"mysql_data":{"name":"kc-gpt-pay2_mysql_data"}}}' ;;
    ps) if [[ "$*" == *app* ]]; then echo fake-app; elif [[ "$*" == *mysql* ]]; then echo fake-mysql; fi ;;
    build)
      [[ ! -e "$project_dir/.env" ]] || { echo 'staging .env was copied' >&2; exit 3; }
      [[ "\${DOCKER_MUTATE_CONFIG:-0}" != 1 ]] || printf 'CHANGED=1\\n' >> "$DOCKER_CONFIG_FILE"
      [[ "\${DOCKER_FAIL_BUILD:-0}" != 1 ]] ;;
    up) if [[ "\${DOCKER_FAIL_UP_ONCE:-0}" == 1 && ! -f "$DOCKER_ONCE" ]]; then : > "$DOCKER_ONCE"; exit 1; fi ;;
    down|logs|pull) exit 0 ;;
    *) echo "unexpected compose command: $cmd" >&2; exit 2 ;;
  esac
  exit $?
fi
if [[ "\${1:-}" == inspect ]]; then
  if [[ "$*" != *--format* ]]; then
    if [[ "$*" == *fake-mysql* ]]; then
      if [[ "\${DOCKER_DB_MOUNT_MISMATCH:-0}" == 1 ]]; then
        echo '[{"Config":{"Env":["MYSQL_ROOT_PASSWORD=dummysecret","MYSQL_DATABASE=plus_papay"]},"Mounts":[{"Type":"volume","Name":"unexpected_mysql_data","Destination":"/var/lib/mysql"}]}]'
      else
        echo '[{"Config":{"Env":["MYSQL_ROOT_PASSWORD=dummysecret","MYSQL_DATABASE=plus_papay"]},"Mounts":[{"Type":"volume","Name":"kc-gpt-pay2_mysql_data","Destination":"/var/lib/mysql"}]}]'
      fi
    elif [[ "\${DOCKER_DB_ENV_MISMATCH:-0}" == 1 ]]; then
      echo '[{"Config":{"Env":["DB_HOST=mysql","DB_PORT=3306","DB_USER=root","DB_PASSWORD=different","DB_NAME=plus_papay"]}}]'
    else
      echo '[{"Config":{"Env":["DB_HOST=mysql","DB_PORT=3306","DB_USER=root","DB_PASSWORD=dummysecret","DB_NAME=plus_papay"]}}]'
    fi
    exit 0
  fi
  case "$*" in
    *State.Health*) echo healthy ;;
    *State.Running*) echo true ;;
    *fake-mysql*) echo sha256:mysql ;;
    *) echo sha256:oldapp ;;
  esac
  exit 0
fi
if [[ "\${1:-}" == image ]]; then
  case "\${2:-}" in
    inspect) if [[ "$*" == *mysql* ]]; then
      if [[ "\${DOCKER_MYSQL_TAG_MISMATCH:-0}" == 1 ]]; then echo sha256:different; else echo sha256:mysql; fi
    else echo sha256:oldapp; fi ;;
    tag|rm) exit 0 ;;
    *) exit 2 ;;
  esac
  exit 0
fi
echo "unexpected docker command" >&2; exit 2
`;
    write(path.join(bin, 'docker'), fakeDocker, 0o755);
    return { project, log, bin, once, update, oldCommit, newCommit };
}

function deploy(f, extra = {}) {
    return spawnSync('bash', [path.join(f.project, 'deploy.sh')], {
        cwd: f.project,
        env: {
            ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`,
            DOCKER_LOG: f.log, DOCKER_ONCE: f.once, DEPLOY_HEALTH_TIMEOUT: '5',
            DOCKER_CONFIG_FILE: path.join(f.project, '.env'),
            TMPDIR: scratch, ...extra
        },
        encoding: 'utf8', timeout: 30000
    });
}

function output(result) {
    return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function assertDataKept(f) {
    expect(fs.readFileSync(path.join(f.project, '.env'), 'utf8')).toBe('PORT=28080\nSECRET=kept-private\n');
    expect(fs.readFileSync(path.join(f.project, 'data', 'runtime.json'), 'utf8')).toBe('persistent data');
    expect(fs.readFileSync(path.join(f.project, 'debug_screenshots', 'image.png'), 'utf8')).toBe('image');
    expect(fs.readFileSync(path.join(f.project, 'product_files', 'product.txt'), 'utf8')).toBe('product');
}

describe('one-command deployment', () => {
    afterEach(() => {
        if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
        scratch = undefined;
    });

    it('builds before removing only the project stack and preserves data and local edits', () => {
        const f = fixture();
        const run = deploy(f);
        expect(run.error, output(run)).toBeUndefined();
        expect(run.status, output(run)).toBe(0);
        expect(git(f.project, 'rev-parse', 'HEAD')).toBe(f.newCommit);
        expect(fs.readFileSync(path.join(f.project, 'server.js'), 'utf8')).toBe('new server\n');
        assertDataKept(f);
        expect(git(f.project, 'show', 'stash@{0}:local.txt')).toBe('user local modification');
        expect(git(f.project, 'show', 'stash@{0}^3:notes.txt')).toBe('user untracked note');
        expect(git(f.project, 'for-each-ref', '--format=%(objectname)', 'refs/kc-deploy-backups')).toBe(f.oldCommit);
        const lines = fs.readFileSync(f.log, 'utf8').split('\n');
        const build = lines.findIndex((line) => / build app$/.test(line));
        const down = lines.findIndex((line) => / down /.test(line));
        expect(build).toBeGreaterThanOrEqual(0);
        expect(down).toBeGreaterThan(build);
        expect(lines[down]).not.toContain('--rmi');
        expect(lines[down]).not.toMatch(/(?:^|\s)(?:-v|--volumes)(?:\s|$)/);
        expect(lines.some((line) => line === 'image rm kc-gpt-pay2-app')).toBe(true);
        expect(output(run)).not.toContain('kept-private');
    });

    it('leaves the old service and local changes untouched when the new image cannot build', () => {
        const f = fixture();
        const run = deploy(f, { DOCKER_FAIL_BUILD: '1' });
        expect(run.status).not.toBe(0);
        expect(git(f.project, 'rev-parse', 'HEAD')).toBe(f.oldCommit);
        expect(fs.readFileSync(path.join(f.project, 'local.txt'), 'utf8')).toBe('user local modification\n');
        expect(fs.readFileSync(path.join(f.project, 'notes.txt'), 'utf8')).toBe('user untracked note\n');
        assertDataKept(f);
        expect(fs.readFileSync(f.log, 'utf8')).not.toMatch(/ down /);
    });

    it('does not stop services if configuration changes during a long build', () => {
        const f = fixture();
        const run = deploy(f, { DOCKER_MUTATE_CONFIG: '1' });
        expect(run.status).not.toBe(0);
        expect(output(run)).toContain('配置文件在构建期间发生变化');
        expect(fs.readFileSync(f.log, 'utf8')).not.toMatch(/ down /);
        expect(git(f.project, 'rev-parse', 'HEAD')).toBe(f.oldCommit);
    });

    it('retains an old image when another container still uses it', () => {
        const f = fixture();
        const run = deploy(f, { DOCKER_OTHER_CONTAINER: '1' });
        expect(run.status, output(run)).toBe(0);
        expect(fs.readFileSync(f.log, 'utf8')).not.toMatch(/^image rm kc-gpt-pay2-app$/m);
        expect(output(run)).toContain('旧应用镜像仍被其他容器使用');
        assertDataKept(f);
    });

    it('does not stop services when the MySQL image tag has changed', () => {
        const f = fixture();
        const run = deploy(f, { DOCKER_MYSQL_TAG_MISMATCH: '1' });
        expect(run.status).not.toBe(0);
        expect(output(run)).toContain('MySQL 当前容器与镜像标签不一致');
        expect(fs.readFileSync(f.log, 'utf8')).not.toMatch(/ down /);
        expect(git(f.project, 'rev-parse', 'HEAD')).toBe(f.oldCommit);
        assertDataKept(f);
    });

    it('does not stop services if current database credentials differ from Compose', () => {
        const f = fixture();
        const run = deploy(f, { DOCKER_DB_ENV_MISMATCH: '1' });
        expect(run.status).not.toBe(0);
        expect(output(run)).toContain('数据库配置不一致');
        expect(output(run)).not.toContain('dummysecret');
        expect(output(run)).not.toContain('different');
        expect(fs.readFileSync(f.log, 'utf8')).not.toMatch(/ down /);
        assertDataKept(f);
    });

    it('refuses to replace a running database with a different data volume', () => {
        const f = fixture();
        const run = deploy(f, { DOCKER_DB_MOUNT_MISMATCH: '1' });
        expect(run.status).not.toBe(0);
        expect(output(run)).toContain('数据挂载与 Compose 配置不一致');
        expect(fs.readFileSync(f.log, 'utf8')).not.toMatch(/ down /);
        assertDataKept(f);
    });

    it('refuses to ignore an existing Compose override file', () => {
        const f = fixture();
        write(path.join(f.project, 'docker-compose.override.yml'), 'services: {}\n');
        const run = deploy(f);
        expect(run.status).not.toBe(0);
        expect(output(run)).toContain('自定义覆盖文件');
        expect(fs.readFileSync(path.join(f.project, 'docker-compose.override.yml'), 'utf8')).toBe('services: {}\n');
        assertDataKept(f);
    });

    it('refuses to ignore a custom Compose file selected in .env', () => {
        const f = fixture();
        fs.appendFileSync(path.join(f.project, '.env'), 'COMPOSE_FILE=custom.yml\n');
        const run = deploy(f);
        expect(run.status).not.toBe(0);
        expect(output(run)).toContain('自定义 COMPOSE_FILE');
        expect(fs.readFileSync(f.log, 'utf8')).not.toMatch(/ down /);
    });

    it('stops before deployment when the remote tracks runtime data', () => {
        const f = fixture();
        write(path.join(f.update, 'data', 'unsafe.txt'), 'unexpected tracked data');
        git(f.update, 'add', '-f', 'data/unsafe.txt');
        git(f.update, 'commit', '-m', 'unexpected runtime data');
        git(f.update, 'push', 'origin', 'main');
        const run = deploy(f);
        expect(run.status).not.toBe(0);
        expect(output(run)).toContain('Git 跟踪了运行数据或环境配置');
        expect(fs.readFileSync(f.log, 'utf8')).not.toMatch(/ down /);
        expect(git(f.project, 'rev-parse', 'HEAD')).toBe(f.oldCommit);
        assertDataKept(f);
    });

    it('protects runtime files that were accidentally tracked in the existing checkout', () => {
        const f = fixture();
        git(f.project, 'add', '-f', '.env');
        const run = deploy(f);
        expect(run.status).not.toBe(0);
        expect(output(run)).toContain('Git 跟踪了运行数据或环境配置');
        expect(fs.readFileSync(f.log, 'utf8')).not.toMatch(/ down /);
        assertDataKept(f);
    });

    it('stops before deployment if the remote does not yet contain the deploy script', () => {
        const f = fixture();
        git(f.update, 'rm', 'deploy.sh');
        git(f.update, 'commit', '-m', 'remove deploy script');
        git(f.update, 'push', 'origin', 'main');
        const run = deploy(f);
        expect(run.status).not.toBe(0);
        expect(output(run)).toContain('远程分支尚未包含 deploy.sh');
        expect(fs.readFileSync(f.log, 'utf8')).not.toMatch(/ down /);
        expect(fs.existsSync(path.join(f.project, 'deploy.sh'))).toBe(true);
        assertDataKept(f);
    });

    it('restores old code, local changes and the old image if the new container fails', () => {
        const f = fixture();
        const run = deploy(f, { DOCKER_FAIL_UP_ONCE: '1' });
        expect(run.status).not.toBe(0);
        expect(git(f.project, 'rev-parse', 'HEAD')).toBe(f.oldCommit);
        expect(fs.readFileSync(path.join(f.project, 'server.js'), 'utf8')).toBe('old server\n');
        expect(fs.readFileSync(path.join(f.project, 'local.txt'), 'utf8')).toBe('user local modification\n');
        expect(fs.readFileSync(path.join(f.project, 'notes.txt'), 'utf8')).toBe('user untracked note\n');
        assertDataKept(f);
        const log = fs.readFileSync(f.log, 'utf8');
        expect((log.match(/ up -d --no-build/g) || []).length).toBe(2);
        expect(log).toMatch(/image tag kc-gpt-pay2-deploy:backup-[^ ]+ kc-gpt-pay2-app/);
        expect(output(run)).toContain('尝试恢复');
    });
});
