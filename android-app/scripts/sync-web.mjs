/*
 * sync-web.mjs - build the Capacitor webDir (www/) FROM the untouched web game.
 *
 * The web game at ../ (projects/game-01-skyhook) is the single source of truth
 * and is never modified. This script:
 *   1. copies the game's shipping assets (index.html, css/, js/, icon assets)
 *      into www/,
 *   2. copies the Capacitor-only bridge modules (src/native/*) into www/,
 *   3. injects a single <script type="module" src="skyhook-native.js"> tag
 *      before </body> in the COPIED index.html only.
 *
 * Result: the Android build reuses the exact same game code; the only delta is
 * the injected native bridge, which lives entirely in this project.
 *
 * Run automatically before every `npx cap sync` (see package.json).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');       // android-app/
const gameRoot = path.resolve(projectRoot, '..');        // game-01-skyhook/
const wwwDir = path.join(projectRoot, 'www');
const nativeDir = path.join(projectRoot, 'src', 'native');

// Assets the SHIPPED game needs (test/, docs/, screenshots excluded).
const COPY_FROM_GAME = ['index.html', 'css', 'js'];
const OPTIONAL_FROM_GAME = ['screenshot.png'];

async function rmrf(p) { await fs.rm(p, { recursive: true, force: true }); }

async function copyRec(src, dest) {
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    for (const entry of await fs.readdir(src)) {
      await copyRec(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function main() {
  await rmrf(wwwDir);
  await fs.mkdir(wwwDir, { recursive: true });

  // 1. game assets
  for (const rel of COPY_FROM_GAME) {
    const src = path.join(gameRoot, rel);
    if (!(await exists(src))) throw new Error('sync-web: missing game asset ' + rel + ' at ' + src);
    await copyRec(src, path.join(wwwDir, rel));
  }
  for (const rel of OPTIONAL_FROM_GAME) {
    const src = path.join(gameRoot, rel);
    if (await exists(src)) await copyRec(src, path.join(wwwDir, rel));
  }

  // 2. native bridge modules
  for (const f of ['skyhook-native.js', 'monetisation.mjs', 'ad-gate.mjs', 'ads.mjs', 'billing.mjs']) {
    await fs.copyFile(path.join(nativeDir, f), path.join(wwwDir, f));
  }

  // 3. inject the bridge into the COPIED index.html only
  const indexPath = path.join(wwwDir, 'index.html');
  let html = await fs.readFile(indexPath, 'utf8');
  const tag = '<script type="module" src="skyhook-native.js"></script>';
  if (!html.includes(tag)) {
    if (html.includes('</body>')) html = html.replace('</body>', '  ' + tag + '\n</body>');
    else html += '\n' + tag + '\n';
  }
  await fs.writeFile(indexPath, html, 'utf8');

  console.log('sync-web: www/ built from untouched game source + native bridge injected.');
}

main().catch((e) => { console.error(e); process.exit(1); });
