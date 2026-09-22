#!/usr/bin/env node
/**
 * Load every built bundle the way the app does and check it is usable.
 *
 * The app loads an extension with `require(entryPoint)` from a folder that has
 * no node_modules beside it. A bundle that left a dependency external builds
 * cleanly, passes its unit tests (vitest resolves from the workspace), and then
 * throws MODULE_NOT_FOUND on a user's machine. Requiring the built file from a
 * bare Node process is the only check that catches that before release.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

import { EXTENSIONS_DIR, listExtensionIds, readManifest } from './extension-paths.mjs';

const require = createRequire(import.meta.url);

const failures = [];
for (const id of await listExtensionIds()) {
  const manifest = await readManifest(id);
  const entry = path.join(EXTENSIONS_DIR, id, manifest.main ?? './dist/index.js');
  try {
    const loaded = require(entry);
    if (typeof loaded.activate !== 'function') {
      failures.push(`${id}: ${entry} does not export an activate() function`);
      continue;
    }
    if (loaded.deactivate !== undefined && typeof loaded.deactivate !== 'function') {
      failures.push(`${id}: deactivate is exported but is not a function`);
      continue;
    }
    process.stdout.write(`OK: ${id} loads and exports activate()\n`);
  } catch (error) {
    failures.push(`${id}: ${error.message}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}
