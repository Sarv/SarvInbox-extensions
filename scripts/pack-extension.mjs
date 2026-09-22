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
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { EXTENSIONS_DIR, MANIFEST_NAME, REPO_ROOT, readManifest, sha256 } from './extension-paths.mjs';

const run = promisify(execFile);

/** Files copied into the archive, in the layout the app expects to find them. */
const SHIPPED = [
  { from: MANIFEST_NAME, required: true },
  { from: 'dist/index.js', required: true },
  { from: 'icon.svg', required: false },
  { from: 'README.md', required: false },
];

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
    for (const entry of SHIPPED) {
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
