import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactUrls, errorText } from '../src/core/urls.ts';
import { snowTileUrl } from '../src/effects/snow.ts';
import { OVERPASS_ENDPOINTS } from '../src/extras/places.ts';

test('API keys never reach error messages or logs: the query of every URL is cut off', () => {
    assert.equal(redactUrls('Tile 404: https://tiles.example/v1/12/2212/1392.png?apikey=SECRET&lang=cs'), 'Tile 404: https://tiles.example/v1/12/2212/1392.png?…');
    assert.equal(
        redactUrls('AJAXError: Not Found (404): https://a.example/t?access_token=pk.SECRET, retry https://b.example/t?key=SECRET2.'),
        'AJAXError: Not Found (404): https://a.example/t?…, retry https://b.example/t?….',
    );
    // The winter filter wraps the tile template (with its key) into its own URL.
    const wrapped = snowTileUrl('https://tiles.example/{z}/{x}/{y}?apikey=SECRET').replace('{z}', '1').replace('{x}', '2').replace('{y}', '3');
    assert.ok(!redactUrls(`Bad snow tile URL: ${wrapped}`).includes('SECRET'));
    assert.equal(redactUrls(`failed: "${wrapped}"`), 'failed: "flyover-snow://1/2/3?…"');
    // Linear time on hostile text (a regex with backtracking took seconds here). The limit is
    // generous because test files run in parallel; a quadratic scan would take far longer.
    for (const hostile of ['https://x/?' + ','.repeat(200000) + 'a', 'a'.repeat(200000) + '://x?y', 'https://'.repeat(30000), 'https://x/?a '.repeat(20000)]) {
        const t0 = performance.now();
        redactUrls(hostile);
        assert.ok(performance.now() - t0 < 1000, `${(performance.now() - t0).toFixed(0)} ms`);
    }
    // Nothing else changes.
    for (const plain of ['no url here', 'https://example.com/path/only', 'see https://example.com/#frag', '']) assert.equal(redactUrls(plain), plain);

    assert.equal(errorText(new Error('GET https://x.example/a?token=SECRET failed')), 'Error: GET https://x.example/a?… failed');
    assert.equal(errorText({ message: 'https://x.example/a?k=SECRET' }), 'https://x.example/a?…');
    assert.equal(errorText('plain https://x.example/?k=SECRET'), 'plain https://x.example/?…');
    assert.equal(errorText(null), 'null');
});

test('place names: only Overpass servers outside Russia, all over HTTPS', () => {
    assert.ok(OVERPASS_ENDPOINTS.length >= 2, 'a fallback when the main server is overloaded');
    for (const url of OVERPASS_ENDPOINTS) {
        const host = new URL(url).hostname;
        assert.equal(new URL(url).protocol, 'https:', url);
        assert.ok(!/\.(ru|su|xn--p1ai)$/.test(host) && !/mail\.ru|yandex|vk\.com/.test(host), host);
    }
});
