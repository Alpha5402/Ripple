import { packager } from '@electron/packager';
import { readFile } from 'node:fs/promises';
import './build-icon.js';
const electronVersion = JSON.parse(await readFile('node_modules/electron/package.json', 'utf8')).version;
const paths = await packager({ dir: 'dist/desktop', out: 'release/current', name: 'Ripple', icon: 'dist/Ripple.icns', electronVersion, appBundleId: 'dev.alpha.ripple', platform: 'darwin', arch: 'arm64', overwrite: true, asar: true, prune: false, appCategoryType: 'public.app-category.productivity', extendInfo: { NSHumanReadableCopyright: 'Ripple • Alpha', NSHighResolutionCapable: true } });
console.log(paths.join('\n'));
