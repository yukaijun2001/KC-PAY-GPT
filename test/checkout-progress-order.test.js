'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture(onProgress) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const console = { error: vi.fn() };
    const activeProcesses = new Set();
    const context = vm.createContext({
        spawn: vi.fn(() => child), console, activeProcesses,
        setTimeout, clearTimeout, PROCESS_IDLE_TIMEOUT_MS: 180000,
        logTask: vi.fn(), logTaskChunk: vi.fn(),
        getCheckoutProgress: (output) => output.length,
        analyzeProcessOutput: () => ({ status: 'success', shouldRetry: false })
    });
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const start = source.indexOf('function runCheckoutScript(');
    const end = source.indexOf("\napp.get('/admin'", start);
    vm.runInContext(source.slice(start, end), context);
    const promise = context.runCheckoutScript('test-job', '/synthetic/index.js', {}, 1, onProgress);
    return { child, promise, console, activeProcesses };
}

describe('checkout progress write ordering', () => {
    it('does not resolve the child result until the last progress write settles', async () => {
        const gate = deferred();
        const progress = vi.fn(async () => { await gate.promise; });
        const run = fixture(progress);
        let resolved = false;
        run.promise.then(() => { resolved = true; });

        run.child.stdout.emit('data', Buffer.from('paid'));
        await settle();
        run.child.emit('close', 0, null);
        try {
            await settle();
            expect(progress).toHaveBeenCalledOnce();
            expect(resolved).toBe(false);
        } finally {
            gate.resolve();
            await run.promise;
        }

        expect(resolved).toBe(true);
        expect(run.activeProcesses.size).toBe(0);
    });

    it('serializes stdout and stderr callbacks with their original output snapshots', async () => {
        const gate = deferred();
        const events = [];
        const progress = vi.fn(async (value, output) => {
            events.push(`start:${output}`);
            if (output === 'first') await gate.promise;
            events.push(`end:${output}`);
        });
        const run = fixture(progress);
        run.child.stdout.emit('data', Buffer.from('first'));
        await settle();
        run.child.stderr.emit('data', Buffer.from('|second'));
        run.child.emit('close', 0, null);
        try {
            await settle();
            expect(events).toEqual(['start:first']);
            expect(progress).toHaveBeenCalledTimes(1);
        } finally {
            gate.resolve();
            await run.promise;
        }

        expect(events).toEqual(['start:first', 'end:first', 'start:first|second', 'end:first|second']);
        expect(progress.mock.calls.map(([value, output]) => [value, output]))
            .toEqual([[5, 'first'], [12, 'first|second']]);
        expect((await run.promise).output).toBe('first|second');
    });

    it('logs rejected progress writes and continues the queue without failing payment', async () => {
        const progress = vi.fn()
            .mockRejectedValueOnce(new Error('synthetic progress DB failure'))
            .mockResolvedValueOnce(undefined);
        const run = fixture(progress);
        run.child.stdout.emit('data', Buffer.from('one'));
        run.child.stdout.emit('data', Buffer.from('|two'));
        run.child.emit('close', 0, null);

        const result = await run.promise;
        expect(progress).toHaveBeenCalledTimes(2);
        expect(progress.mock.calls.map(([, output]) => output)).toEqual(['one', 'one|two']);
        expect(run.console.error).toHaveBeenCalled();
        expect(result).toMatchObject({ code: 0, analysis: { status: 'success' }, output: 'one|two' });
        expect(run.activeProcesses.size).toBe(0);
    });
});
