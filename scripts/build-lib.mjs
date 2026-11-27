// Compiles the library to dist/ (ES modules + type declarations) for apps that install it.
// The demo and the tests keep running straight from the TypeScript source.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });

// tsc rewrites "./x.ts" to "./x.js" in the JavaScript but leaves declarations alone. Point them at
// ".js" as well, so they resolve with any TypeScript version and module-resolution setting.
let files = 0;
const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (path.endsWith('.d.ts')) {
            const text = readFileSync(path, 'utf8');
            const fixed = text.replace(/(from\s+|import\()(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2');
            if (fixed !== text) writeFileSync(path, fixed);
            files++;
        }
    }
};
walk('dist');
console.log(`dist/: ${files} declaration files`);
