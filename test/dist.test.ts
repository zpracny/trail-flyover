/** The compiled package (dist/) that apps install: same exports as the source, and it runs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as source from '../src/index.ts';
import { TOLMIN_KOPER } from './helpers/tracks.ts';

const dist = new URL('../dist/', import.meta.url);

test('dist: built by `npm run build:lib`, exports exactly what the source exports', async () => {
    assert.ok(existsSync(new URL('index.js', dist)), 'dist/index.js exists (pretest builds it)');
    const built = await import(new URL('index.js', dist).href);
    assert.deepEqual(Object.keys(built).sort(), Object.keys(source).sort());
    // The package entry points named in package.json exist.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    for (const file of [pkg.main, pkg.types, pkg.exports['.'].import, pkg.exports['.'].types]) {
        assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), file);
    }
    // No TypeScript-only import paths are left in what consumers load.
    const walk = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]));
    for (const file of walk(dist).filter(f => /\.(js|d\.ts)$/.test(f.pathname))) {
        assert.ok(!/from\s+['"]\.{1,2}\/[^'"]+\.ts['"]/.test(readFileSync(file, 'utf8')), `${file.pathname} imports a .ts file`);
    }
});

test('dist: the compiled flight plan gives the same flight as the source', async () => {
    const built = await import(new URL('index.js', dist).href);
    const a = source.buildFlightPlan(TOLMIN_KOPER, { duration: 20, aspect: 0.8 });
    const b = built.buildFlightPlan(TOLMIN_KOPER, { duration: 20, aspect: 0.8 });
    assert.equal(b.length, a.length);
    for (const t of [0, 3.3, 10, 19.99, 20]) {
        assert.deepEqual(b.poseAt(t), a.poseAt(t));
        assert.deepEqual(b.statsAt(t), a.statsAt(t));
    }
});
