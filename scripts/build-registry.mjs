#!/usr/bin/env node
/**
 * Rebuild `registry.json` — the index Sarv Inbox fetches to populate its Browse
 * tab.
 *
 * Usage: node scripts/build-registry.mjs [--dry-run]
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
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  API_BASE,
  RAW_BASE,
  REPO_ROOT,
  REPO_URL,
  compareVersions,
  listExtensionIds,
  parseReleaseTag,
  readManifest,
  sha256,
} from './extension-paths.mjs';

const SCHEMA_VERSION = 1;

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

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ids = await listExtensionIds();
  const releases = indexReleases(await fetchAllReleases());
  const repository = await githubJson(API_BASE).catch(() => null);

  const extensions = [];
  const skipped = [];

  for (const id of ids) {
    const manifest = await readManifest(id);
    const published = releases.get(id);
    if (!published) {
      skipped.push(id);
      continue;
    }
    if (published.version !== manifest.version) {
      process.stderr.write(
        `NOTE: ${id} manifest is at ${manifest.version}, newest release is ${published.version} — listing the released one\n`
      );
    }

    const bytes = await download(published.asset.browser_download_url);

    extensions.push({
      id,
      name: manifest.name,
      version: published.version,
      description: manifest.description,
      author: manifest.author,
      license: manifest.license ?? 'MIT',
      keywords: manifest.keywords ?? [],
      homepage: `${REPO_URL}/tree/main/extensions/${id}`,
      iconUrl: manifest.icon ? `${RAW_BASE}/extensions/${id}/${manifest.icon}` : null,
      readmeUrl: `${RAW_BASE}/extensions/${id}/README.md`,
      engines: manifest.engines ?? {},
      permissions: manifest.permissions ?? [],
      contributes: manifest.contributes ?? {},
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
  }

  process.stderr.write(
    `registry.json: ${extensions.length} listed${skipped.length ? `, ${skipped.length} not yet released (${skipped.join(', ')})` : ''}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
