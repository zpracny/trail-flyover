/** The demo dev server (scripts/devserver.py): only localhost, bounded uploads, no overwrites. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const python = spawnSync('python3', ['--version']).status === 0;

function freePort(): Promise<number> {
    return new Promise(resolve => {
        const s = createServer().listen(0, '127.0.0.1', () => {
            const port = (s.address() as { port: number }).port;
            s.close(() => resolve(port));
        });
    });
}

function send(port: number, method: string, path: string, headers: Record<string, string | number> = {}, body?: string) {
    return new Promise<{ status: number; location?: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode!, location: res.headers.location }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

test('dev server: answers only localhost, uploads stay in out/, are bounded and never overwrite', { skip: !python && 'python3 not installed' }, async () => {
    const out = mkdtempSync(join(tmpdir(), 'flyover-out-'));
    const port = await freePort();
    const server = spawn('python3', ['scripts/devserver.py', String(port), out], { stdio: 'ignore' });
    try {
        // Wait until it listens.
        for (let i = 0; ; i++) {
            try { await send(port, 'HEAD', '/', { Host: `127.0.0.1:${port}` }); break; } catch { if (i > 100) throw new Error('server did not start'); await new Promise(r => setTimeout(r, 50)); }
        }
        const local = { Host: `localhost:${port}` };
        assert.equal((await send(port, 'GET', '/index.html', local)).status, 200);
        assert.equal((await send(port, 'GET', '/index.html', { Host: `[::1]:${port}` })).status, 200);
        // DNS rebinding: the browser sends the attacker's host name.
        assert.equal((await send(port, 'GET', '/index.html', { Host: 'evil.example' })).status, 403);
        assert.equal((await send(port, 'PUT', '/save/x.mp4', { Host: `evil.example:${port}`, 'Content-Length': 3 }, 'abc')).status, 403);

        const put = (name: string, body: string, h: Record<string, string | number> = {}) => send(port, 'PUT', `/save/${name}`, { ...local, 'Content-Length': Buffer.byteLength(body), ...h }, body);
        assert.equal((await put('video.mp4', 'one')).status, 201);
        const second = await put('video.mp4', 'two');
        assert.equal(second.status, 201);
        assert.equal(second.location, '/save/video-1.mp4');
        assert.equal(readFileSync(join(out, 'video.mp4'), 'utf8'), 'one', 'the first file is not overwritten');
        assert.equal(readFileSync(join(out, 'video-1.mp4'), 'utf8'), 'two');
        // Path tricks end up as a plain file name inside out/ (or are refused).
        assert.equal((await put('..%2F..%2Fescape.txt', 'x')).status, 201);
        assert.equal((await put('.hidden', 'x')).status, 400);
        assert.equal((await put('', 'x')).status, 400);
        assert.equal((await send(port, 'PUT', '/elsewhere/a.txt', { ...local, 'Content-Length': 1 }, 'x')).status, 404);
        // Size: declared too large or missing → refused before anything is written.
        assert.equal((await put('huge.bin', '', { 'Content-Length': 3 * 1024 ** 3 })).status, 413);
        assert.equal((await send(port, 'PUT', '/save/nolength.bin', { ...local, 'Transfer-Encoding': 'chunked' }, 'x')).status, 411);
        assert.deepEqual(readdirSync(out).sort(), ['escape.txt', 'video-1.mp4', 'video.mp4']);
    } finally {
        server.kill();
        rmSync(out, { recursive: true, force: true });
    }
});
