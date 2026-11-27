// Bundles the demo and copies MapLibre's worker + CSS next to it.
import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('demo/dist', { recursive: true });
for (const f of ['maplibre-gl-worker.mjs', 'maplibre-gl.css']) copyFileSync(`node_modules/maplibre-gl/dist/${f}`, `demo/dist/${f}`);
// Demo track with its place names (source: OpenStreetMap) — Overpass is often overloaded.
copyFileSync('test/fixtures/tolmin-koper.gpx', 'demo/tolmin.gpx');
copyFileSync('test/fixtures/tolmin-koper.places.json', 'demo/tolmin.places.json');

// --release: what GitHub Pages serves — minified, without the 7 MB source map.
const release = process.argv.includes('--release');
const options = {
  entryPoints: ['demo/main.ts'],
  bundle: true,
  format: 'esm',
  sourcemap: !release,
  minify: release,
  target: 'es2022',
  outfile: 'demo/dist/main.js',
  logLevel: 'info',
};
if (process.argv.includes('--watch')) await (await context(options)).watch();
else await build(options);
