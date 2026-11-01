'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const entrypoint = path.join(__dirname, '..', 'scripts', 'docker-entrypoint.sh');

describe('Docker Xvfb entrypoint', () => {
    let workDir;
    let binDir;
    let pidFile;
    let markerFile;
    let traceFile;

    function executable(name, contents) {
        const file = path.join(binDir, name);
        fs.writeFileSync(file, contents, { mode: 0o755 });
    }

    function launch(overrides = {}) {
        const env = {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
            TMPDIR: workDir,
            XVFB_ENABLED: '1',
            XVFB_START_TIMEOUT_SECONDS: '1',
            KC_TEST_XVFB_PID: pidFile,
            KC_TEST_XVFB_MARKER: markerFile,
            KC_TEST_TRACE: traceFile,
            ...overrides
        };
        if (!Object.prototype.hasOwnProperty.call(overrides, 'DISPLAY')) delete env.DISPLAY;
        if (!Object.prototype.hasOwnProperty.call(overrides, 'XAUTHORITY')) delete env.XAUTHORITY;
        const command = "process.stdout.write('APP_STARTED '+JSON.stringify({display:process.env.DISPLAY||'',authority:process.env.XAUTHORITY||''})+'\\n')";
        return spawnSync('/bin/sh', [entrypoint, process.execPath, '-e', command], {
            env, encoding: 'utf8', timeout: 4500
        });
    }

    beforeEach(() => {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-xvfb-test-'));
        binDir = path.join(workDir, 'bin');
        fs.mkdirSync(binDir);
        pidFile = path.join(workDir, 'xvfb.pid');
        markerFile = path.join(workDir, 'ready');
        traceFile = path.join(workDir, 'trace');
        // Simulate the observed cloud failure: xvfb-run stays alive but never starts the app.
        executable('xvfb-run', '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n');
        executable('Xvfb', `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(process.env.KC_TEST_XVFB_PID, String(process.pid));
if (process.env.KC_TEST_XVFB_EXIT === '1') process.exit(7);
fs.writeFileSync(process.env.KC_TEST_XVFB_MARKER, 'ready');
if (process.env.KC_TEST_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
fs.closeSync(1); fs.closeSync(2);
setInterval(() => {}, 1000);
`);
        executable('xauth', '#!/bin/sh\necho xauth >> "$KC_TEST_TRACE"\ncat >/dev/null\n[ "${KC_TEST_XAUTH_FAIL:-0}" != 1 ]\n');
        executable('xdpyinfo', '#!/bin/sh\n[ "${KC_TEST_PROBE_FAIL:-0}" != 1 ] && [ -f "$KC_TEST_XVFB_MARKER" ]\n');
        executable('timeout', '#!/bin/sh\nshift\nexec "$@"\n');
    });

    afterEach(() => {
        try {
            const pid = Number(fs.readFileSync(pidFile, 'utf8'));
            if (pid > 1) process.kill(pid, 'SIGTERM');
        } catch (_) { /* already exited */ }
        fs.rmSync(workDir, { recursive: true, force: true });
    });

    it('starts the app without waiting for xvfb-run or a SIGUSR1 signal', () => {
        const result = launch();
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/APP_STARTED .*"display":":\d+"/);
        expect(result.stdout).toContain('"authority":');
    });

    it('continues without a display when Xvfb exits immediately', () => {
        const result = launch({ KC_TEST_XVFB_EXIT: '1' });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('"display":""');
        expect(result.stderr).toMatch(/Xvfb/);
    });

    it('bounds the wait when Xvfb stays alive but never becomes ready', () => {
        const result = launch({ KC_TEST_PROBE_FAIL: '1' });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('"display":""');
        expect(result.stderr).toMatch(/Xvfb/);
    });

    it('does not hang if a failed Xvfb ignores SIGTERM', () => {
        const result = launch({ KC_TEST_PROBE_FAIL: '1', KC_TEST_IGNORE_TERM: '1' });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('APP_STARTED');
        expect(result.stdout).toContain('"display":""');
    });

    it('still starts the app if X authority setup fails', () => {
        const result = launch({ KC_TEST_XAUTH_FAIL: '1' });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('"display":""');
        expect(result.stderr).toMatch(/Xvfb/);
        expect(fs.existsSync(pidFile)).toBe(false);
    });

    it('respects disabled Xvfb and a pre-existing display', () => {
        const disabled = launch({ XVFB_ENABLED: '0' });
        expect(disabled.status).toBe(0);
        expect(disabled.stdout).toContain('"display":""');
        expect(fs.existsSync(pidFile)).toBe(false);

        const existing = launch({ DISPLAY: ':123', XAUTHORITY: '/existing/auth' });
        expect(existing.status).toBe(0);
        expect(existing.stdout).toContain('"display":":123"');
        expect(existing.stdout).toContain('"authority":"/existing/auth"');
        expect(fs.existsSync(pidFile)).toBe(false);
    });
});
