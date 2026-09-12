import { Resvg } from '@resvg/resvg-js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const svg = await readFile('apps/desktop/icon.svg', 'utf8');
const folder = 'dist/Ripple.iconset'; await mkdir(folder, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size * scale } }).render().asPng();
  await writeFile(`${folder}/icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`, png);
}
execFileSync('iconutil', ['-c', 'icns', folder, '-o', 'dist/Ripple.icns']);
