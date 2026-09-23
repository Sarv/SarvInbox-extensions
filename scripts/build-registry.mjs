#!/usr/bin/env node
/**
 * Rebuild the registry — what Sarv Inbox fetches to populate its Browse tab.
 *
 * Usage: node scripts/build-registry.mjs [--dry-run]
 *
 * Two artifacts come out of one run, from the same data:
 *
 * - `registry.json`, pretty-printed and complete. This is the file a human
 *   reviews: every release shows up as a readable diff, one field per line, and
 *   a changed checksum or a new permission is impossible to miss. Nothing reads
 *   it over the network.
 * - `registry/`, minified and split. `registry/index.json` carries only the
 *   fields the Browse list actually draws; everything else — the download URL,
 *   the pinned digest, the `contributes` block — lives in `registry/e/<id>.json`,
 *   fetched for the one extension a user chose to install. This is what the app
 *   requests, so the cost of opening Browse does not grow with what an
 *   extension happens to declare.
 *
 * URLs inside `registry/` are relative to the document that carries them, which
 * keeps them short and, more usefully, keeps them on whichever host served the
 * index: point the app at a CDN mirror and the icons come from the mirror too,
 * with nothing to reconfigure.
 *
 * Everything the app needs to INSTALL an extension comes from here, including
 * the SHA-256 it verifies the download against. That hash is computed by
 * downloading the published asset and hashing it, never copied from a side
 * channel: the point of pinning it is to notice if the bytes GitHub serves ever
 * stop matching the bytes that were released, and a hash taken from the same
 * release metadata would not.
 *
 * An extension with no published release is left out rather than listed as
 * uninstallable — the registry describes what can be installed today.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Parser } from 'tar';

import {
  API_BASE,
  MANIFEST_NAME,
  RAW_BASE,
  REPO_ROOT,
  REPO_URL,
  compareVersions,
  listExtensionIds,
  parseReleaseTag,
  readManifest,
  sha256,
} from './extension-paths.mjs';

/** The shape of `registry.json`: one flat list, every field inline. */
const SCHEMA_VERSION = 1;
/** The shape of `registry/`: a thin index plus one detail doc per extension. */
const SERVED_SCHEMA_VERSION = 2;
const SERVED_DIR = path.join(REPO_ROOT, 'registry');

function githubHeaders() {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'sarvinbox-registry-builder',
    'x-github-api-version': '2022-11-28',
  };
  // Actions gives us a token; without one the API allows 60 requests an hour,
  // which is enough for a manual run but not for a busy CI queue.
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function githubJson(url) {
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchAllReleases() {
  const releases = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await githubJson(`${API_BASE}/releases?per_page=100&page=${page}`);
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases.filter((release) => !release.draft);
}

async function download(url) {
  const response = await fetch(url, {
    headers: { ...githubHeaders(), accept: 'application/octet-stream' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * The manifest INSIDE a published archive.
 *
 * Regression: this used to describe every entry with the manifest sitting in
 * the working tree while pinning the download to an already-published archive.
 * The two drift the moment a manifest changes without a release — and the app
 * re-checks the archive's own permissions against the ones the registry listed,
 * so it refused the install outright ("Archive asks for different permissions
 * than the registry listed"). The registry must describe the bytes it pins, so
 * the manifest is read back out of those exact bytes.
 */
async function manifestInArchive(id, bytes) {
  const found = await new Promise((resolve, reject) => {
    const chunks = [];
    let matched = false;
    const parser = new Parser({
      onReadEntry(entry) {
        // Archives are published with a leading folder, and tar paths always
        // use '/' whatever built them.
        const name = entry.path.replace(/^[^/]+\//, '');
        if (name !== MANIFEST_NAME) {
          entry.resume();
          return;
        }
        matched = true;
        entry.on('data', (chunk) => chunks.push(chunk));
      },
    });
    parser.on('end', () => resolve(matched ? Buffer.concat(chunks) : null));
    parser.on('error', reject);
    parser.end(bytes);
  });

  if (!found) throw new Error(`${id}: published archive contains no ${MANIFEST_NAME}`);

  const manifest = JSON.parse(found.toString('utf8'));
  if (manifest.id !== id) {
    throw new Error(`${id}: published archive declares id "${manifest.id}"`);
  }
  return manifest;
}

/**
 * Group releases by extension id and keep the newest version of each, summing
 * downloads across EVERY release of that extension — a download count that reset
 * on each release would tell the user nothing about how used an extension is.
 */
function indexReleases(releases) {
  const byExtension = new Map();
  for (const release of releases) {
    const parsed = parseReleaseTag(release.tag_name ?? '');
    if (!parsed) continue;
    const asset = (release.assets ?? []).find((candidate) => candidate.name.endsWith('.tgz'));
    if (!asset) continue;

    const downloads = (release.assets ?? [])
      .filter((candidate) => candidate.name.endsWith('.tgz'))
      .reduce((total, candidate) => total + (candidate.download_count ?? 0), 0);

    const existing = byExtension.get(parsed.id);
    const entry = { ...parsed, release, asset, downloads: downloads + (existing?.downloads ?? 0) };
    if (!existing || compareVersions(parsed.version, existing.version) > 0) {
      byExtension.set(parsed.id, entry);
    } else {
      existing.downloads = entry.downloads;
    }
  }
  return byExtension;
}

/**
 * The thin entry the Browse list is drawn from.
 *
 * Deliberately not "everything except the download block": each field is here
 * because a card renders it. `contributes` is the clearest case — it is the
 * largest field in the whole document and the app's parser has never read it,
 * so every byte of it was paid for on every refresh by every user for nothing.
 *
 * `homepage` stays absolute: the app hands it straight to the OS browser from a
 * renderer loaded over `file://`, where a relative URL would resolve to nothing.
 */
/**
 * The part of `contributes` the Browse LIST needs.
 *
 * The app turns this into "what this does and where you will see it", which is
 * the question being asked while browsing - before anything has been clicked,
 * so it has to ride along in the thin index. Only the fields that produce a
 * sentence survive: a workflow's whole configuration block would put kilobytes
 * of machine-facing settings in a document every user downloads on every
 * refresh, to render one line of text.
 */
function contributesSummary(contributes = {}) {
  const summary = {};
  const panels = (contributes.panels ?? []).map((panel) => ({
    title: panel.title,
    surface: panel.surface,
    ...(panel.autoOpen ? { autoOpen: true } : {}),
  }));
  const workflows = (contributes.workflows ?? []).map((workflow) => ({
    name: workflow.name,
    ...(workflow.requiresAI ? { requiresAI: true } : {}),
  }));
  const settings = (contributes.settings ?? []).map((setting) => ({ key: setting.key }));
  const capabilities = (contributes.capabilities ?? []).map((capability) => ({
    id: capability.id,
    ...(capability.description ? { description: capability.description } : {}),
  }));

  if (panels.length > 0) summary.panels = panels;
  if (workflows.length > 0) summary.workflows = workflows;
  if (settings.length > 0) summary.settings = settings;
  if (capabilities.length > 0) summary.capabilities = capabilities;
  return Object.keys(summary).length > 0 ? summary : null;
}

/**
 * Screenshot URLs, absolute and on a host the app will actually load from.
 *
 * An author writes a path inside their own extension folder, the same way they
 * write `icon`. It is expanded here rather than left relative because the app
 * refuses any image URL outside the registry's host allowlist - a screenshot is
 * fetched simply by drawing the catalogue, so an arbitrary host would be a
 * request made on the reader's behalf for an extension they have not installed.
 */
function screenshotUrls(id, screenshots) {
  if (!Array.isArray(screenshots)) return null;
  const resolved = screenshots
    .filter((shot) => shot && typeof shot.url === 'string' && shot.url.trim() !== '')
    .map((shot) => ({
      url: /^https?:\/\//.test(shot.url)
        ? shot.url
        : `${RAW_BASE}/extensions/${id}/${shot.url.replace(/^\.?\//, '')}`,
      ...(shot.caption ? { caption: shot.caption } : {}),
    }));
  return resolved.length > 0 ? resolved : null;
}

function thinEntry(entry) {
  return {
    id: entry.id,
    name: entry.name,
    version: entry.version,
    description: entry.description,
    author: entry.author,
    keywords: entry.keywords,
    category: entry.category,
    homepage: entry.homepage,
    // Relative to `registry/index.json`, so the detail document and the icon
    // follow the index to whatever host it is served from.
    iconUrl: entry.iconUrl ? `../extensions/${entry.id}/${path.basename(entry.iconUrl)}` : null,
    detailUrl: `e/${entry.id}.json`,
    engines: entry.engines,
    permissions: entry.permissions,
    contributes: contributesSummary(entry.contributes),
    screenshots: entry.screenshots,
    // The list shows a size for every extension; only the chosen one costs a
    // second request to learn where those bytes are and what they must hash to.
    size: entry.download.size,
    stats: entry.stats,
  };
}

/**
 * Everything the thin entry left out, for one extension.
 *
 * `id` and `version` are repeated so the app can refuse a detail document that
 * has drifted from the index it was reached through - the user is about to
 * approve permissions for the version they were shown, and installing a
 * different one is the failure this check exists to prevent.
 */
function detailDocument(entry) {
  return {
    schemaVersion: SERVED_SCHEMA_VERSION,
    id: entry.id,
    version: entry.version,
    license: entry.license,
    category: entry.category,
    homepage: entry.homepage,
    // Relative to `registry/e/<id>.json`.
    readmeUrl: `../../extensions/${entry.id}/README.md`,
    engines: entry.engines,
    permissions: entry.permissions,
    contributes: entry.contributes,
    screenshots: entry.screenshots,
    download: entry.download,
  };
}

/** Write the artifacts the app actually fetches: minified, and split in two. */
async function writeServedRegistry(registry) {
  // Rebuilt from scratch so an extension that was withdrawn cannot leave a
  // detail document behind for anyone holding an older index.
  await rm(SERVED_DIR, { recursive: true, force: true });
  await mkdir(path.join(SERVED_DIR, 'e'), { recursive: true });

  const index = {
    schemaVersion: SERVED_SCHEMA_VERSION,
    generatedAt: registry.generatedAt,
    source: registry.source,
    stats: registry.stats,
    extensions: registry.extensions.map(thinEntry),
  };
  await writeFile(path.join(SERVED_DIR, 'index.json'), JSON.stringify(index), 'utf8');

  for (const entry of registry.extensions) {
    await writeFile(
      path.join(SERVED_DIR, 'e', `${entry.id}.json`),
      JSON.stringify(detailDocument(entry)),
      'utf8'
    );
  }

  const indexBytes = Buffer.byteLength(JSON.stringify(index), 'utf8');
  process.stderr.write(
    `registry/index.json: ${indexBytes} bytes for ${registry.extensions.length} entries, plus ${registry.extensions.length} detail document(s)\n`
  );
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ids = await listExtensionIds();
  const releases = indexReleases(await fetchAllReleases());
  const repository = await githubJson(API_BASE).catch(() => null);

  const extensions = [];
  const skipped = [];

  for (const id of ids) {
    const source = await readManifest(id);
    const published = releases.get(id);
    if (!published) {
      skipped.push(id);
      continue;
    }

    const bytes = await download(published.asset.browser_download_url);
    // Everything below comes from the archive, not from `source`: the working
    // tree is where the NEXT release is being written, and describing an entry
    // with it would promise users something the download does not contain.
    const manifest = await manifestInArchive(id, bytes);
    if (source.version !== manifest.version) {
      process.stderr.write(
        `NOTE: ${id} is at ${source.version} in the tree, newest release is ${manifest.version} — listing the released one\n`
      );
    }

    extensions.push({
      id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      license: manifest.license ?? 'MIT',
      keywords: manifest.keywords ?? [],
      // Passed through as written; the app folds it onto its own known list of
      // shelves, so the registry does not need to know what those are.
      category: manifest.category ?? null,
      homepage: `${REPO_URL}/tree/main/extensions/${id}`,
      iconUrl: manifest.icon
        ? `${RAW_BASE}/extensions/${id}/${manifest.icon.replace(/^\.?\//, '')}`
        : null,
      readmeUrl: `${RAW_BASE}/extensions/${id}/README.md`,
      engines: manifest.engines ?? {},
      permissions: manifest.permissions ?? [],
      contributes: manifest.contributes ?? {},
      screenshots: screenshotUrls(id, manifest.screenshots),
      download: {
        url: published.asset.browser_download_url,
        sha256: sha256(bytes),
        size: bytes.byteLength,
        publishedAt: published.release.published_at,
        releaseTag: published.release.tag_name,
      },
      stats: {
        downloads: published.downloads,
      },
    });
  }

  const registry = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: REPO_URL,
    stats: {
      stars: repository?.stargazers_count ?? 0,
      watchers: repository?.subscribers_count ?? 0,
    },
    extensions,
  };

  const json = `${JSON.stringify(registry, null, 2)}\n`;
  if (dryRun) {
    process.stdout.write(json);
  } else {
    await writeFile(path.join(REPO_ROOT, 'registry.json'), json, 'utf8');
    await writeServedRegistry(registry);
  }

  process.stderr.write(
    `registry.json: ${extensions.length} listed${skipped.length ? `, ${skipped.length} not yet released (${skipped.join(', ')})` : ''}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
