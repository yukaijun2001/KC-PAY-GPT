'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

const storePath = path.join(__dirname, '../src/persistence/mysql-store.js');

function fixture(rows = []) {
    const query = vi.fn(async (sql, params) => {
        if (/SELECT proxy_url\s+FROM proxy_assets/.test(sql)) {
            const candidates = rows.filter(row => row.is_active === 1
                && (!/region_code = \?/.test(sql) || row.region_code === params[0]));
            return [candidates.slice(0, 1)];
        }
        if (/SELECT id FROM proxy_assets/.test(sql)) return [[]];
        return [rows];
    });
    const execute = vi.fn(async () => [{ affectedRows: 1, insertId: 7 }]);
    const createPool = vi.fn(() => ({ query, execute }));
    const actualRequire = createRequire(storePath);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(storePath, 'utf8'), {
        require: name => name === 'mysql2/promise' ? { createPool } : actualRequire(name),
        module, process: { env: {} }, console, Buffer, __dirname: path.dirname(storePath),
        setTimeout, clearTimeout, setInterval, clearInterval
    }, { filename: storePath });
    return { store: module.exports, query, execute, createPool };
}

describe('proxy country labels and selection', () => {
    it('selects only enabled proxies with the explicitly requested country label', async () => {
        const run = fixture([
            { proxy_url: 'http://unlabeled.invalid:8080', is_active: 1, region_code: '' },
            { proxy_url: 'http://ph.invalid:8080', is_active: 1, region_code: 'PH' },
            { proxy_url: 'http://eg-off.invalid:8080', is_active: 0, region_code: 'EG' },
            { proxy_url: 'http://eg.invalid:8080', is_active: 1, region_code: 'EG' }
        ]);
        expect(await run.store.getActiveProxy('eg')).toBe('http://eg.invalid:8080');
        expect(run.query.mock.calls[0][0]).toMatch(/is_active = 1 AND region_code = \?/);
        expect(run.query.mock.calls[0][1]).toEqual(['EG']);
        expect(run.query.mock.calls[0][0]).toContain('ORDER BY RAND()');
        expect(run.execute).toHaveBeenCalledWith(expect.stringContaining('usage_count = usage_count + 1'), ['http://eg.invalid:8080']);
    });

    it.each([
        { rows: [] },
        { rows: [{ proxy_url: 'http://ph.invalid:8080', is_active: 1, region_code: 'PH' }] },
        { rows: [{ proxy_url: 'http://eg.invalid:8080', is_active: 0, region_code: 'EG' }] },
        { rows: [{ proxy_url: 'http://unlabeled.invalid:8080', is_active: 1, region_code: '' }] }
    ])('fails closed when no enabled Egyptian proxy matches: %j', async ({ rows }) => {
        const run = fixture(rows);
        await expect(run.store.getActiveProxy('EG')).rejects.toThrow(/埃及（EG）/);
        expect(run.query).toHaveBeenCalledOnce();
        expect(run.execute).not.toHaveBeenCalled();
    });

    it('does not return an empty selected proxy as a direct connection', async () => {
        const run = fixture([{ proxy_url: '', is_active: 1, region_code: 'PH' }]);
        await expect(run.store.getActiveProxy('PH')).rejects.toThrow(/菲律宾（PH）/);
        expect(run.execute).not.toHaveBeenCalled();
    });

    it('preserves legacy unfiltered selection when no country argument is supplied', async () => {
        const run = fixture([{ proxy_url: 'http://legacy.invalid:8080', is_active: 1, region_code: '' }]);
        expect(await run.store.getActiveProxy()).toBe('http://legacy.invalid:8080');
        expect(run.query.mock.calls[0][0]).not.toContain('region_code =');
        expect(run.query.mock.calls[0][1]).toEqual([]);
        expect(await fixture().store.getActiveProxy()).toBe('');
    });

    it('retains per-task sticky session substitution after region selection', async () => {
        const run = fixture([{ proxy_url: 'http://session-{session}@eg.invalid:8080', is_active: 1, region_code: 'EG' }]);
        const proxy = await run.store.getActiveProxy('EG');
        expect(proxy).toMatch(/^http:\/\/session-[a-z0-9]+@eg\.invalid:8080$/);
        expect(proxy).not.toContain('{session}');
    });

    it.each(['ZZ', '埃及', 'EG OR 1=1', false, null, 42])('rejects invalid country labels before querying: %j', async code => {
        const run = fixture();
        expect(await run.store.addProxyAssets('http://example.invalid:8080', code)).toMatchObject({ success: false });
        expect(await run.store.setProxyAssetRegion(7, code)).toMatchObject({ success: false });
        await expect(run.store.getActiveProxy(code)).rejects.toThrow('不支持的代理国家标签');
        expect(run.createPool).not.toHaveBeenCalled();
    });

    it.each(['PH', 'US', 'SG', 'MY', 'EG', ''])('persists the selected label on import and row updates: %s', async code => {
        const run = fixture();
        expect(await run.store.addProxyAssets('http://example.invalid:8080', code)).toMatchObject({ success: true, added: 1 });
        expect(run.execute.mock.calls[0][0]).toContain('region_code');
        expect(run.execute.mock.calls[0][1][4]).toBe(code);
        expect(await run.store.setProxyAssetRegion(7, code)).toMatchObject({ success: true, region_code: code });
        expect(run.execute.mock.calls[1]).toEqual([
            expect.stringContaining('SET region_code = ? WHERE id = ?'), [code, 7]
        ]);
    });

    it('keeps imported proxies unlabelled by default, without inferring from their URL', async () => {
        const run = fixture();
        await run.store.addProxyAssets('http://region-EG@example.invalid:8080');
        expect(run.execute.mock.calls[0][1][4]).toBe('');
    });

    it('keeps existing free-text labels separate from the new country label', async () => {
        const run = fixture([{ id: 7, proxy_url: 'http://eg.invalid:8080', label: 'team note', region_code: 'EG', is_active: 1 }]);
        expect(await run.store.listProxyAssets()).toMatchObject([{ id: 7, label: 'team note', region_code: 'EG' }]);
        expect((await fixture([{ id: 8 }]).store.listProxyAssets())[0].region_code).toBe('');
    });

    it('reports missing proxies and rejects invalid row IDs without a write', async () => {
        const run = fixture();
        run.execute.mockResolvedValueOnce([{ affectedRows: 0 }]);
        expect(await run.store.setProxyAssetRegion(7, 'EG')).toMatchObject({ success: false, error: '代理不存在' });
        for (const id of [0, -1, 'not-an-id']) {
            expect(await run.store.setProxyAssetRegion(id, 'EG')).toMatchObject({ success: false });
        }
        expect(run.execute).toHaveBeenCalledOnce();
    });

    it('declares an empty default in both new schema and additive application migration', () => {
        const schema = fs.readFileSync(path.join(__dirname, '../mysql-schema.sql'), 'utf8');
        const source = fs.readFileSync(storePath, 'utf8');
        const migration = fs.readFileSync(path.join(__dirname, '../database/mysql-update-stripe.sql'), 'utf8');
        expect(schema).toMatch(/region_code VARCHAR\(2\) NOT NULL DEFAULT ''/);
        expect(source).toContain("ensureColumn('proxy_assets', 'region_code', \"VARCHAR(2) NOT NULL DEFAULT ''\")");
        expect(migration).toContain("column_name = 'region_code'");
        expect(migration).not.toMatch(/UPDATE proxy_assets SET region_code/);
    });
});
