#!/usr/bin/env node
/**
 * Pack one built extension into the `.tgz` that gets attached to a GitHub
 * release, and print its SHA-256.
 *
 * Usage: node scripts/pack-extension.mjs <extension-id> [--out release]
 *
 * The archive is FLAT (`sarvinbox-extension.json` and `dist/index.js` sit at the
 * root, with no `package/` prefix) because the app extracts it straight into the
 * extension's install folder. Adding a prefix here would mean the installer has
 * to guess how many leading components to strip, and guessing wrong is how you
 * get an extension folder containing one folder containing the extension.
 *
 * Only what the app actually loads is included: no sources, no tests, no
 * sourcemaps, no node_modules. The bundle is already self-contained.
 */
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { EXTENSIONS_DIR, MANIFEST_NAME, REPO_ROOT, readManifest, sha256 } from './extension-paths.mjs';

const run = promisify(execFile);

/**
 * Files copied into the archive, in the layout the app expects to find them.
 *
 * Screenshots are deliberately absent: they are a before-you-install
 * question, the catalogue reads them straight from the repo over https,
 * and shipping them would put megabytes of pictures on the disk of every
 * reader who already decided to install. The icon does ship, because an
 * installed extension still has to show one with no network.
 */
const SHIPPED = [
  { from: MANIFEST_NAME, required: true },
  { from: 'dist/index.js', required: true },
  { from: 'icon.svg', required: false },
  { from: 'README.md', required: false },
];

/**
 * File types a panel page is allowed to load.
 *
 * The same allow-list the app serves under (`panelAssetContentType` in
 * `@sarvinbox/core`): anything outside it is refused by the panel protocol at
 * runtime, so shipping it would only add weight to the archive.
 */
const PANEL_ASSET_EXTENSIONS = new Set([
  'html', 'htm', 'js', 'mjs', 'css', 'json', 'map',
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico',
  'woff', 'woff2', 'ttf', 'otf',
]);

/**
 * The panel files to ship, derived from the manifest.
 *
 * A panel entry names one HTML file, but that page pulls in a stylesheet, a
 * script and whatever else it draws with — none of which the manifest lists.
 * Rather than parse the HTML for its references, the convention is that a
 * panel lives in its own directory and that directory ships whole. The entry
 * MUST therefore be in a subdirectory: a panel entry at the extension root
 * would make "its directory" mean the whole extension, sweeping up sources,
 * screenshots and anything else the author left lying about.
 *
 * Without this an extension that declares a panel packs and releases cleanly
 * and then shows an empty frame on the reader's machine, because the page the
 * manifest points at was never in the archive.
 */
async function panelFiles(sourceDir, manifest) {
  const panels = manifest.contributes?.panels ?? [];
  const shipped = new Map();

  for (const panel of panels) {
    const entry = String(panel.entry ?? '');
    const dir = path.posix.dirname(entry);
    if (!entry || dir === '.' || dir === '/' || entry.startsWith('..')) {
      throw new Error(
        `panel '${panel.id}': entry '${entry}' must live in a subdirectory, e.g. panel/index.html`
      );
    }

    const absolute = path.join(sourceDir, dir);
    const names = await readdir(absolute, { recursive: true, withFileTypes: true });
    for (const item of names) {
      if (!item.isFile()) continue;
      const extension = path.extname(item.name).slice(1).toLowerCase();
      if (!PANEL_ASSET_EXTENSIONS.has(extension)) continue;
      // `parentPath` is where the entry was found; on Node 20 it is `path`.
      const from = path.relative(sourceDir, path.join(item.parentPath ?? item.path, item.name));
      shipped.set(from, { from, required: false });
    }

    if (!shipped.has(entry)) {
      throw new Error(`panel '${panel.id}': ${entry} is missing`);
    }
  }

  return [...shipped.values()];
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const [id, ...rest] = process.argv.slice(2);
  if (!id) throw new Error('usage: node scripts/pack-extension.mjs <extension-id> [--out <dir>]');

  const outFlag = rest.indexOf('--out');
  const outDir = path.resolve(REPO_ROOT, outFlag === -1 ? 'release' : rest[outFlag + 1]);

  const sourceDir = path.join(EXTENSIONS_DIR, id);
  const manifest = await readManifest(id);

  const staging = await mkdtemp(path.join(tmpdir(), `sarvinbox-ext-${id}-`));
  try {
    for (const entry of [...SHIPPED, ...(await panelFiles(sourceDir, manifest))]) {
      const from = path.join(sourceDir, entry.from);
      if (!(await exists(from))) {
        if (entry.required) {
          throw new Error(`${id}: ${entry.from} is missing — run "pnpm --filter @sarvinbox-ext/${id} build" first`);
        }
        continue;
      }
      const to = path.join(staging, entry.from);
      await mkdir(path.dirname(to), { recursive: true });
      await cp(from, to);
    }
    // The repository licence travels with the extension: a folder the user can
    // open on disk should say what its terms are without a round trip.
    const licence = path.join(REPO_ROOT, 'LICENSE');
    if (await exists(licence)) await cp(licence, path.join(staging, 'LICENSE'));

    await mkdir(outDir, { recursive: true });
    const archive = path.join(outDir, `${id}-${manifest.version}.tgz`);
    await rm(archive, { force: true });
    // `-C staging .` keeps the archive flat; both BSD and GNU tar accept this form.
    await run('tar', ['-czf', archive, '-C', staging, '.']);

    const bytes = await readFile(archive);
    const digest = sha256(bytes);
    const { size } = await stat(archive);
    await writeFile(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`, 'utf8');

    const summary = { id, version: manifest.version, archive, size, sha256: digest };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

    // Consumed by the release workflow to name the asset and the tag.
    if (process.env.GITHUB_OUTPUT) {
      await writeFile(
        process.env.GITHUB_OUTPUT,
        [
          `archive=${archive}`,
          `checksum_file=${archive}.sha256`,
          `version=${manifest.version}`,
          `sha256=${digest}`,
          `size=${size}`,
          '',
        ].join('\n'),
        { flag: 'a' }
      );
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
