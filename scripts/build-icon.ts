import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
// Convert the supplied brand asset at build time; keep its original alpha channel.
const source = 'apps/workbench/public/brand/ripple-logo.png';
const folder = 'dist/Ripple.iconset'; await mkdir(folder, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
  execFileSync('sips', ['-z', String(size * scale), String(size * scale), source, '--out', `${folder}/icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`], { stdio: 'pipe' });
}
execFileSync('iconutil', ['-c', 'icns', folder, '-o', 'dist/Ripple.icns']);
