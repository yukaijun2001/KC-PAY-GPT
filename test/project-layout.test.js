'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

describe('project layout and persistent paths', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('keeps the application entrypoints and groups internal modules', () => {
        for (const relative of [
            'server.js', 'index.js',
            'src/browser/browser-pool.js', 'src/browser/session-auth.js',
            'src/checkout/chatgpt.js', 'src/config/region-config.js',
            'src/persistence/mysql-store.js', 'src/captcha/hcaptcha-runtime.js',
            'mysql-schema.sql', 'database/mysql-update-stripe.sql'
        ]) {
            expect(fs.existsSync(path.join(root, relative)), relative).toBe(true);
        }
    });

    it('resolves all relative imports from their relocated source files', () => {
        function collect(dir) {
            return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
                const name = path.join(dir, entry.name);
                return entry.isDirectory() ? collect(name) : (name.endsWith('.js') ? [name] : []);
            });
        }
        const files = [path.join(root, 'server.js'), path.join(root, 'index.js'), ...collect(path.join(root, 'src'))];
        for (const file of files) {
            const resolver = createRequire(file);
            const source = fs.readFileSync(file, 'utf8');
            for (const match of source.matchAll(/\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
                expect(() => resolver.resolve(match[1]), `${path.relative(root, file)}: ${match[1]}`).not.toThrow();
            }
        }
    });

    it('resolves the project root independently of process.cwd()', () => {
        const { projectPath } = require('../src/project-paths');
        expect(projectPath('data', 'browser-pool')).toBe(path.join(root, 'data', 'browser-pool'));
        expect(projectPath('debug_screenshots')).toBe(path.join(root, 'debug_screenshots'));
        const helper = path.join(root, 'src', 'project-paths.js');
        const run = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(helper)}).projectPath('data'))`], {
            cwd: os.tmpdir(), encoding: 'utf8'
        });
        expect(run.status).toBe(0);
        expect(run.stdout).toBe(path.join(root, 'data'));
    });

    it('keeps the existing Python solver location as the default', () => {
        vi.stubEnv('HCAPTCHA_SOLVER_SCRIPT', '');
        const { buildHcaptchaEnvFromConfig } = require('../src/captcha/hcaptcha-runtime');
        const { DEFAULT_SOLVER_SCRIPT } = require('../src/captcha/hcaptcha-solver');
        const expected = path.join(root, 'hcaptcha', 'solver.py');
        expect(buildHcaptchaEnvFromConfig({}).env.HCAPTCHA_SOLVER_SCRIPT).toBe(expected);
        expect(DEFAULT_SOLVER_SCRIPT).toBe(expected);
        expect(fs.existsSync(expected)).toBe(true);
    });

    it('keeps database initialization and persisted captcha config paths correct', () => {
        vi.stubEnv('HCAPTCHA_CONFIG_FILE', '');
        const filename = path.join(root, 'src', 'persistence', 'mysql-store.js');
        const module = { exports: {} };
        const source = fs.readFileSync(filename, 'utf8');
        const context = vm.createContext({
            module, exports: module.exports, __dirname: path.dirname(filename), __filename: filename,
            require: createRequire(filename), process, console, Buffer, URL, setTimeout, clearTimeout
        });
        vm.runInContext(`${source}\nmodule.exports.__paths = { SCHEMA_PATH, resolveHcaptchaConfigFilePath };`, context);
        expect(module.exports.__paths.SCHEMA_PATH).toBe(path.join(root, 'mysql-schema.sql'));
        expect(fs.existsSync(module.exports.__paths.SCHEMA_PATH)).toBe(true);
        expect(module.exports.__paths.resolveHcaptchaConfigFilePath()).toBe(path.join(root, 'data', 'hcaptcha-config.json'));
    });

    it('continues to resolve task media cleanup under the original screenshots directory', () => {
        const filename = path.join(root, 'src', 'persistence', 'mysql-store.js');
        const realRequire = createRequire(filename);
        const existsSync = vi.fn(() => true);
        const unlinkSync = vi.fn();
        const module = { exports: {} };
        const context = vm.createContext({
            module, exports: module.exports, __dirname: path.dirname(filename), __filename: filename,
            require: (name) => name === 'fs' ? { ...fs, existsSync, unlinkSync } : realRequire(name),
            process, console, Buffer, URL, setTimeout, clearTimeout
        });
        vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
        const result = module.exports.deleteTaskMediaFiles({
            failure_screenshots: JSON.stringify(['checkout_debug/error.png'])
        });
        expect(result.deleted).toBe(1);
        expect(unlinkSync).toHaveBeenCalledWith(path.join(root, 'debug_screenshots', 'checkout_debug', 'error.png'));
    });

    it('keeps persistent browser profiles under the existing data directory', async () => {
        const filename = path.join(root, 'src', 'browser', 'browser-pool.js');
        const module = { exports: {} };
        const mkdirSync = vi.fn();
        const launchPersistentContext = vi.fn(async () => ({ pages: () => [] }));
        const realRequire = createRequire(filename);
        const context = vm.createContext({
            module, exports: module.exports, __dirname: path.dirname(filename), __filename: filename,
            require: (name) => {
                if (name === 'fs') return { ...fs, mkdirSync };
                if (name === 'playwright-extra') return { chromium: { use() {}, launchPersistentContext } };
                if (name === 'puppeteer-extra-plugin-stealth') return () => ({});
                return realRequire(name);
            },
            process, console, setTimeout, clearTimeout
        });
        vm.runInContext(`${fs.readFileSync(filename, 'utf8')}\nmodule.exports.__warmSlot = warmSlot;`, context);
        await module.exports.__warmSlot(3);
        const expected = path.join(root, 'data', 'browser-pool', 'slot-3');
        expect(mkdirSync).toHaveBeenCalledWith(expected, { recursive: true });
        expect(launchPersistentContext.mock.calls[0][0]).toBe(expected);
    });
});
