import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('vendor/mark-it/build', { recursive: true });
await build({ entryPoints: ['vendor/mark-it/src/index.ts'], bundle: true, format: 'esm', platform: 'browser', outfile: 'vendor/mark-it/build/index.js', external: ['katex', 'katex/*', 'prismjs', 'dompurify'], loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' } });
await writeFile('vendor/mark-it/build/index.d.ts', `export class Editor {
  constructor(container: HTMLDivElement, title?: string, source?: string, metadata?: undefined, options?: { htmlPolicy?: 'sanitize' | 'escape' });
  getMarkdownSource(): string;
  onContentChange(callback: (markdown: string) => void): void;
  replaceAll(query: string, replacement: string, caseSensitive?: boolean): number;
  destroy(): void;
  view: { title: HTMLDivElement; area: HTMLDivElement };
}
`);
