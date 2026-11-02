'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const dockerCheck = spawnSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8' });
const composeTest = dockerCheck.status === 0 ? it : it.skip;

function resolvedCompose(extraEnv = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-compose-test-'));
    const envFile = path.join(dir, 'empty.env');
    fs.writeFileSync(envFile, '');
    const env = { ...process.env, ...extraEnv };
    if (!Object.prototype.hasOwnProperty.call(extraEnv, 'PORT')) delete env.PORT;
    delete env.COMPOSE_FILE;
    delete env.COMPOSE_PROJECT_NAME;
    delete env.COMPOSE_PROFILES;
    try {
        const run = spawnSync('docker', ['compose', '--env-file', envFile, '-f', path.join(root, 'docker-compose.yml'), 'config', '--format', 'json'], {
            cwd: root, env, encoding: 'utf8'
        });
        if (run.status !== 0) throw new Error('docker compose config failed');
        return JSON.parse(run.stdout);
    } finally {
        fs.unlinkSync(envFile);
        fs.rmdirSync(dir);
    }
}

describe('Docker host port configuration', () => {
    composeTest('retains the existing 3100 host port when PORT is unset', () => {
        const config = resolvedCompose();
        expect(String(config.services.app.ports[0].published)).toBe('3100');
        expect(Number(config.services.app.ports[0].target)).toBe(3000);
    });

    composeTest('honors the 28080 example configuration', () => {
        const config = resolvedCompose({ PORT: '28080' });
        expect(String(config.services.app.ports[0].published)).toBe('28080');
        expect(Number(config.services.app.ports[0].target)).toBe(3000);
    });

    composeTest('mounts the organized source and database schema without changing data volumes', () => {
        const config = resolvedCompose();
        const appVolumes = config.services.app.volumes;
        expect(appVolumes).toContainEqual(expect.objectContaining({
            type: 'bind', source: path.join(root, 'src'), target: '/app/src', read_only: true
        }));
        expect(appVolumes).toContainEqual(expect.objectContaining({
            type: 'bind', source: path.join(root, 'data'), target: '/app/data'
        }));
        expect(config.services.mysql.volumes).toContainEqual(expect.objectContaining({
            type: 'bind', source: path.join(root, 'mysql-schema.sql'),
            target: '/docker-entrypoint-initdb.d/01-schema.sql', read_only: true
        }));
        expect(config.services.mysql.volumes).toContainEqual(expect.objectContaining({
            type: 'volume', source: 'mysql_data', target: '/var/lib/mysql'
        }));
        expect(config.volumes.mysql_data.name).toBe('kc-gpt-pay2_mysql_data');
    });
});

describe('default web paths', () => {
    let server;
    let base;

    beforeAll(async () => {
        const sourcePath = path.join(root, 'server.js');
        const realRequire = createRequire(sourcePath);
        const fakeStore = {
            ensureReady: vi.fn(async () => {}),
            getAdminPaths: vi.fn(async () => ({ loginPath: 'admin-login', panelPath: 'admin' })),
            getMaxConcurrentActivations: vi.fn(async () => 2)
        };
        const fakeProcess = {
            env: { ...process.env, IS_PRODUCT_FLOW: 'true' },
            on: vi.fn(), pid: process.pid, platform: process.platform,
            cwd: () => root, exit: vi.fn()
        };
        const module = { exports: {} };
        const context = vm.createContext({
            module, exports: module.exports, __dirname: root, __filename: sourcePath,
            require: (name) => name === './src/persistence/mysql-store' ? fakeStore : realRequire(name),
            process: fakeProcess, console: { log() {}, warn() {}, error() {} },
            Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval
        });
        vm.runInContext(fs.readFileSync(sourcePath, 'utf8') + '\nmodule.exports = app;', context, { filename: sourcePath });
        server = await new Promise((resolve) => {
            const listener = module.exports.listen(0, '127.0.0.1', () => resolve(listener));
        });
        base = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        if (server) await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    });

    it('serves the public homepage and configured default admin login path', async () => {
        expect((await fetch(`${base}/`)).status).toBe(200);
        expect((await fetch(`${base}/admin-login`)).status).toBe(200);
    });

    it('serves the runtime endpoint used by the container healthcheck', async () => {
        const response = await fetch(`${base}/api/public/runtime`);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ success: true });
    });

    it('does not expose the deliberately disabled legacy html path', async () => {
        expect((await fetch(`${base}/admin-login.html`)).status).toBe(404);
    });
});
