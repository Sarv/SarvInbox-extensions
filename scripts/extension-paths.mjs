import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXTENSIONS_DIR = path.join(REPO_ROOT, 'extensions');
export const MANIFEST_NAME = 'sarvinbox-extension.json';

/**
 * The GitHub repository this registry is published from.
 *
 * Every URL the app is handed derives from these two values, so a fork only has
 * to change them here (or set GITHUB_REPOSITORY, which Actions sets for us).
 */
const [envOwner, envRepo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
export const OWNER = envOwner || 'Sarv';
export const REPO = envRepo || 'SarvInbox-extensions';
export const REPO_URL = `https://github.com/${OWNER}/${REPO}`;
export const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;
export const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main`;

/** `<id>-v<version>` — one tag namespace shared by every extension in the repo. */
export function releaseTag(id, version) {
  return `${id}-v${version}`;
}

export function parseReleaseTag(tag) {
  const match = /^(.+)-v(\d+\.\d+\.\d+(?:[-+].*)?)$/.exec(tag);
  return match ? { id: match[1], version: match[2] } : null;
}

/** Newest-first ordering for semver strings, prereleases sorting below releases. */
export function compareVersions(left, right) {
  const split = (value) => {
    const [core, pre = ''] = value.split('-', 2);
    return { parts: core.split('.').map(Number), pre };
  };
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === '') return 1;
  if (b.pre === '') return -1;
  return a.pre < b.pre ? -1 : 1;
}

export async function listExtensionIds() {
  const entries = await readdir(EXTENSIONS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

export async function readManifest(id) {
  const file = path.join(EXTENSIONS_DIR, id, MANIFEST_NAME);
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (manifest.id !== id) {
    throw new Error(`${file}: manifest id "${manifest.id}" does not match its folder name "${id}"`);
  }
  return manifest;
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
