# Sarv Inbox Extensions

[![CI](https://github.com/Sarv/SarvInbox-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/Sarv/SarvInbox-extensions/actions/workflows/ci.yml)
[![Stars](https://img.shields.io/github/stars/Sarv/SarvInbox-extensions?style=flat&label=stars)](https://github.com/Sarv/SarvInbox-extensions/stargazers)
[![Downloads](https://img.shields.io/github/downloads/Sarv/SarvInbox-extensions/total?label=downloads)](https://github.com/Sarv/SarvInbox-extensions/releases)
[![Licence](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

Extensions for [Sarv Inbox](https://github.com/Sarv/Inbox), and the registry
the app installs them from.

The app reads [`registry/index.json`](registry/index.json). Each entry names a
`.tgz` attached to a GitHub release, and [`registry/e/`](registry/e) holds one
document per extension with that archive's URL and its pinned SHA-256. So an
install is: fetch the index, fetch the one detail document for what the user
chose, download the archive, check the hash, show the user what permissions the
extension is asking for, and only then unpack it. Nothing is executed before
that hash matches.

[`registry.json`](registry.json) at the root is the same data, complete and
pretty-printed. It is the file to *read*: every release lands as a legible
diff, one field per line, so a changed checksum or a new permission is
impossible to miss in review. Nothing fetches it — the split index exists so
that opening the Browse tab does not download the `contributes` block of every
extension that has ever been published. Both come out of the same
`scripts/build-registry.mjs` run and cannot drift apart.

URLs inside `registry/` are relative to the document carrying them. That keeps
them short, and it keeps them on whichever host served the index: point an app
at a CDN mirror of this repository and the icons and detail documents come from
the mirror too, with nothing to reconfigure.

---

## Contents

- [The extensions](#the-extensions)
- [Installing](#installing)
- [Build your own](#build-your-own)
  - [1. Scaffold](#1-scaffold)
  - [2. The manifest](#2-the-manifest)
  - [3. The entry point](#3-the-entry-point)
  - [4. The context object](#4-the-context-object)
  - [5. Workflows](#5-workflows)
  - [6. Notification cards](#6-notification-cards)
  - [7. Settings](#7-settings)
  - [8. Offering an API to the app](#8-offering-an-api-to-the-app)
  - [9. Test it](#9-test-it)
  - [10. Try it in the app](#10-try-it-in-the-app)
- [Publishing](#publishing)
  - [Into this registry](#into-this-registry)
  - [From your own repository](#from-your-own-repository)
- [Downloads, stars and ratings](#downloads-stars-and-ratings)
- [Permissions reference](#permissions-reference)
- [Registry format](#registry-format)
- [Repository layout](#repository-layout)
- [Licence](#licence)

---

## The extensions

| Extension | What it does | Permissions |
| --- | --- | --- |
| [`otp-code`](extensions/otp-code) | Spots a verification code as it arrives and puts it on screen with a copy button and a live countdown to expiry, so you never open the mail to read six digits | `email:read` `email:label` `storage:local` `settings:read` `ui:notify` |
| [`vip-scoring`](extensions/vip-scoring) | Learns who you actually correspond with — who you reply to, how fast, how often — and tags the mail that matters | `email:read` `email:label` `storage:local` `settings:read` |
| [`email-summarization`](extensions/email-summarization) | Summarises a long thread on demand, and caches the result so re-opening it is free | `email:read` `ai:use` `storage:local` `settings:read` |

## Installing

**From the app** — Settings, Extensions, Browse. Pick one, read the permissions
it asks for, confirm. That is the path this repository exists to serve.

**By hand** — download a `.tgz` from [Releases](../../releases), check it against
the `.sha256` beside it, and unpack it into your extensions folder:

```bash
shasum -a 256 -c otp-code-1.0.0.tgz.sha256
mkdir -p ~/.sarvinbox/extensions/otp-code
tar -xzf otp-code-1.0.0.tgz -C ~/.sarvinbox/extensions/otp-code
```

Then use **Install Extension** in the Extensions panel and point it at that
folder.

---

## Build your own

You need Node 20+, pnpm, and about twenty minutes.

An extension is **one bundled CommonJS file** plus a manifest. The app loads it
with `require()` from a folder that has no `node_modules` beside it, so whatever
it imports has to be bundled in. That single constraint explains most of the
setup below.

### 1. Scaffold

The fastest start is to copy an existing one. `otp-code` is the smallest
complete example — a workflow, a notification card, settings, storage and
tests — and it is about 9 KB built.

```bash
git clone https://github.com/Sarv/SarvInbox-extensions
cd SarvInbox-extensions
cp -r extensions/otp-code extensions/my-extension
rm -rf extensions/my-extension/dist extensions/my-extension/node_modules
pnpm install
```

Working on your own instead of inside this repository? Start from an empty
folder:

```bash
mkdir my-extension && cd my-extension
pnpm init
pnpm add -D @sarvinbox/extension-sdk tsup typescript vitest @types/node
```

Either way you end up with:

```
my-extension/
├── sarvinbox-extension.json   # the manifest — the app reads this, not package.json
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── icon.svg                   # optional, your logo in Browse and the Extensions panel
├── screenshot-*.svg           # optional, pictures of it running, shown before installing
├── README.md
├── src/
│   └── index.ts               # must export activate()
└── test/
    └── unit/
```

`package.json`:

```json
{
  "name": "@sarvinbox-ext/my-extension",
  "version": "1.0.0",
  "private": true,
  "description": "One line, shown in the Extensions panel",
  "license": "MIT",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "type-check": "tsc --noEmit"
  },
  "devDependencies": {
    "@sarvinbox/extension-sdk": "^1.0.0",
    "@types/node": "^20.11.0",
    "tsup": "^8.0.1",
    "typescript": "^5.3.3",
    "vitest": "^1.2.0"
  }
}
```

`tsup.config.ts` — the important part is `noExternal`:

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  outDir: 'dist',
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Nothing may be left as an external require: the app loads this file from a
  // folder with no node_modules beside it.
  noExternal: [/.*/],
});
```

`tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "noEmit": true },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### 2. The manifest

`sarvinbox-extension.json` is what the app reads — its id, its permissions and
what it contributes. `package.json` is only for your build.

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "description": "One or two sentences. This is what people read before installing.",
  "author": "Your Name",
  "repository": "https://github.com/you/my-extension",
  "license": "MIT",
  "main": "./dist/index.js",
  "icon": "icon.svg",
  "keywords": ["productivity"],
  "category": "productivity",
  "screenshots": [
    { "url": "screenshot-panel.svg", "caption": "Where it shows up, and what it looks like doing its job" }
  ],
  "engines": {
    "sarvinbox": "^1.1.0"
  },
  "permissions": ["email:read", "email:label", "storage:local", "settings:read"],
  "contributes": {
    "workflows": [
      {
        "id": "my-workflow",
        "name": "Do the thing",
        "description": "Runs over every arriving message",
        "priority": 50,
        "requiresBody": false,
        "enabledByDefault": true
      }
    ],
    "settings": [
      {
        "key": "my-extension.enabled",
        "type": "boolean",
        "default": true,
        "description": "Turn the thing on"
      }
    ],
    "events": ["email:synced"]
  }
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Lowercase, hyphenated, unique. Must equal the folder name. Becomes the storage namespace and the release tag prefix — changing it later is a new extension |
| `name` | yes | Shown in the UI |
| `version` | yes | Semver. Must match the release tag you push |
| `description` | yes | Shown in Browse and in the permission prompt |
| `author` | yes | |
| `main` | yes | Path to the bundled entry point, relative to the manifest |
| `engines.sarvinbox` | yes | Semver range of app versions this works with. The app refuses to install outside it |
| `permissions` | yes | See the [reference](#permissions-reference). Ask for the least you need — this list is shown to the user verbatim |
| `contributes.workflows` | no | Declared here AND registered in `activate` (see below) |
| `contributes.settings` | no | Rendered in the Extensions panel |
| `contributes.events` | no | Pipeline events you subscribe to. **Note this lives inside `contributes`**, not at the top level |
| `icon` | no | Your logo, a path inside the folder. Drawn in an `<img>`, so give it literal colours - a `currentColor` stroke has nothing to inherit and comes out black. Check it at 32px. Ships inside the archive too, so an installed extension has an icon offline |
| `category` | no | One shelf for the Browse list. The app folds it onto `productivity`, `security`, `organisation`, `communication`, `office`, `ai`, `tools`, `other` (common synonyms included); anything else becomes `other`. Grants nothing, restricts nothing |
| `screenshots` | no | `[{ url, caption }]`, paths inside the folder. Shown on the extension's page before installing - answer *what will I see, and where?* Read over https rather than shipped, so they cost an installed reader nothing |
| `keywords`, `homepage`, `repository`, `license` | no | Metadata for the Browse tab |

`icon` and `screenshots` paths are expanded by the registry into absolute URLs
on a host the app will load from — the catalogue draws them for extensions
nobody has installed yet, so an arbitrary host would be a request made on the
reader's behalf. Write a path, not a URL.

The registry describes the **released archive**, not your working tree: a new
`category` or `screenshots` list reaches Browse with the release that contains
it. The image files themselves are read from the repository, so redrawing an
icon needs no release — renaming one does.

### 3. The entry point

`src/index.ts` must export `activate(context)`. `deactivate()` is optional.

```ts
import type { EmailRecord, ExtensionContext } from '@sarvinbox/extension-sdk';
import { addTag, hasTag } from '@sarvinbox/extension-sdk';

let context: ExtensionContext | null = null;

export function activate(ctx: ExtensionContext): void {
  context = ctx;
  ctx.log.info('my-extension activating');

  ctx.registerWorkflow({
    id: 'my-workflow',
    name: 'Do the thing',
    priority: 50,
    requiresBody: false,

    // Cheap and synchronous where you can make it: this runs on every message.
    shouldProcess: (email: EmailRecord) => !hasTag(email.tags, 'mine'),

    process: async (email, workflow) => {
      workflow.log.debug(`looking at ${email.id}`);
      if (!/invoice/i.test(email.subject ?? '')) return { success: true };
      return {
        success: true,
        modifications: { tags: addTag(email.tags, 'mine') },
      };
    },
  });
}

export function deactivate(): void {
  context?.log.info('my-extension deactivating');
  context = null;
}
```

Everything in `context.subscriptions` is disposed for you when the extension is
disabled; anything else you start — a timer, an interval — you unwind in
`deactivate`.

`EmailRecord.tags` is a `|a|b|c|` delimited **string**, not an array. Use
`hasTag` / `addTag` / `removeTag` / `parseTags` from the SDK rather than
splitting it yourself; hand-rolled tag editing is how tag corruption gets in.

`EmailRecord.date` and `receivedDate` are unix **seconds**. Anything you store
yourself should be UTC epoch **milliseconds** — mixing the two silently yields
values off by a factor of 1000.

### 4. The context object

| Member | Needs | What it is |
| --- | --- | --- |
| `manifest` | — | Your own manifest, parsed |
| `storagePath` | — | Absolute path to your private folder |
| `registerWorkflow(w)` / `unregisterWorkflow(id)` | — | See [Workflows](#5-workflows) |
| `events.on(event, handler)` | — | Pipeline events. Push the returned unsubscribe into `subscriptions` |
| `storage` | `storage:local` | `get` / `set` / `delete` / `keys` / `clear`, all async, JSON-serialisable values |
| `ai` | `ai:use` | `complete`, `summarize`, `categorize`, `extractActionItems`, `isAvailable()`. Undefined without the permission |
| `settings` | `settings:read` | `get(key)`, `has(key)`; `update(key, value)` additionally needs `settings:write` |
| `ui` | `ui:notify` | `notify(card)` / `dismiss(id)` — see [Notification cards](#6-notification-cards) |
| `log` | — | `debug` / `info` / `warn` / `error`, into the app log |
| `subscriptions` | — | Push unsubscribe functions here; disposed on deactivate |
| `exports` | — | The API you offer the rest of the app — see [below](#8-offering-an-api-to-the-app) |

**`storage` rewrites its whole JSON file on every `set`.** If you record
something per message, coalesce the writes — `createFlushScheduler` from the SDK
exists for exactly this.

**If you loop over many messages, yield on a TIME budget**, never on a row
count: `createLoopYielder` from the SDK. A `i % 500` yield assumes a fixed
per-row cost and will freeze the window the day it is wrong.

### 5. Workflows

A workflow runs over arriving mail. Declare it in the manifest and register it
in `activate` — the manifest entry is what the user sees and toggles, the
registration is what actually runs.

```ts
ctx.registerWorkflow({
  id: 'my-workflow',      // must match contributes.workflows[].id
  name: 'Do the thing',
  priority: 50,           // lower runs first
  requiresBody: true,     // see below
  shouldProcess: (email) => true,
  process: async (email, workflow) => ({ success: true }),
});
```

`process` returns:

```ts
{
  success: boolean,
  modifications?: { tags?: string, isRead?: boolean, isStarred?: boolean, ... },
  labelsToAdd?: string[],
  labelsToRemove?: string[],
  skipRemaining?: boolean,   // stop lower-priority workflows for this message
  metadata?: Record<string, unknown>,
  error?: Error,
}
```

**The two-stage contract — read this one twice.** Message bodies are fetched
*after* the message itself arrives. So a workflow with `requiresBody: true` runs
**twice** for the same message: once at arrival with no body, once again when
the body lands. Your `process` must be idempotent. Returning the same tag twice
is harmless; incrementing a counter twice is a bug that only shows up in
production.

Without `requiresBody`, the workflow runs once, at arrival, with headers only.

The app runs these **serially**, one message at a time, with a bounded queue — a
first sync of forty thousand messages will not start forty thousand of your
workflows at once. A slow `process` slows the queue for everyone, so keep the
work proportionate and push anything expensive behind `shouldProcess`.

### 6. Notification cards

With `ui:notify` you can put a card in the bottom-right of the window. This is
for something the user needs *now* — a code that expires in five minutes is the
motivating case, since a tag they find ten minutes later is the same as nothing.

```ts
ctx.ui.notify({
  id: `code-${email.id}`,          // same id replaces the card in place
  title: 'Verification code',
  body: 'From Acme',
  fields: [{ label: 'Code', value: '493028', copyable: true, emphasis: true }],
  expiresAt: Date.now() + 5 * 60 * 1000,   // UTC epoch ms; drives a live countdown
  emailId: email.id,               // adds an "Open the message" link
});
```

Everything is sanitised in the main process before it reaches the window:
strings are capped at 2,000 characters, malformed fields are dropped, and the id
is namespaced by extension so one extension can neither replace nor dismiss
another's card. At most three cards are visible at once, newest first.

### 7. Settings

Declare them in `contributes.settings` and they appear in the Extensions panel.
Read them with `settings:read`:

```ts
const enabled = ctx.settings.get('my-extension.enabled') ?? true;
```

Namespace every key with your extension id. Writing needs `settings:write`,
which is a permission most extensions should not ask for.

### 8. Offering an API to the app

Anything you assign to `context.exports` during `activate` is reachable by the
host, which is how an extension can be called on demand instead of only on
arriving mail:

```ts
ctx.exports = {
  summarizeThread: async (emails) => ({ /* ... */ }),
};
```

`email-summarization` uses this: the app's `extension:summarizeThread` IPC
handler looks up the exports of whichever extension provides that shape and
calls it when the user clicks Summarise.

### 9. Test it

Tests ship with the extension, not after it. Keep the logic in small pure
modules and the framework glue thin — `otp-code` splits detection
(`otp-detect.ts`) from the card it builds (`otp-notification.ts`) from the
wiring (`index.ts`) for exactly this reason.

```bash
pnpm --filter @sarvinbox-ext/my-extension test
pnpm --filter @sarvinbox-ext/my-extension type-check
pnpm --filter @sarvinbox-ext/my-extension build
```

Then load the built bundle the way the app does, from a bare Node process:

```bash
node scripts/verify-bundle.mjs
```

This is not ceremony. A dependency accidentally left external builds cleanly and
passes vitest — which resolves from your workspace — and then throws
`MODULE_NOT_FOUND` on a user's machine. Requiring the built file outside the
workspace is the only check that catches it.

**Watch the bundle size.** Run `ls -l extensions/*/dist/index.js` after a build.
`otp-code` is ~9 KB and `vip-scoring` ~14 KB; if yours is suddenly hundreds of
KB, something CommonJS got pulled in and cannot be tree-shaken back out. The
usual culprit is importing `@sarvinbox/extension-sdk/text`, which is a separate
entry point precisely so that cost is opt-in.

### 10. Try it in the app

```bash
pnpm --filter @sarvinbox-ext/my-extension build
```

In Sarv Inbox: Settings, Extensions, **Install Extension**, and pick the
`extensions/my-extension` folder. The app reads the manifest, shows you the
permissions, and activates it.

Set `SARV_DEBUG_EXTENSIONS=1` before launching to get per-message workflow
tracing in the app log.

---

## Publishing

### Into this registry

This is the path that gets you listed in the app's Browse tab for everyone.

1. **Open a pull request** adding `extensions/<your-id>/`. CI runs type-check,
   the tests, the build and the bundle check on it.
2. A maintainer reviews it. The review is mostly about the permission list: an
   extension that asks for `email:delete` to highlight newsletters does not get
   merged.
3. Once merged, a maintainer pushes the release tag:

   ```bash
   git tag my-extension-v1.0.0
   git push origin my-extension-v1.0.0
   ```

   The tag format is `<extension-id>-v<version>` and the version **must** match
   `sarvinbox-extension.json`; the workflow fails the release if they disagree.

4. [`.github/workflows/release.yml`](.github/workflows/release.yml) then, with no
   further input: verifies the whole repository, packs
   `<id>-<version>.tgz`, creates the GitHub release with the archive and a
   `.sha256` beside it, re-runs `scripts/build-registry.mjs`, and commits the
   updated `registry.json` and `registry/` to `main`.

   The checksum in the registry is computed by **downloading the published
   asset and hashing it**, not copied from the build job. The point of pinning a
   hash is to notice if the bytes GitHub serves ever stop matching the bytes
   that were released, and a hash taken from the same release metadata would
   not do that.

5. The app picks it up on its next registry fetch.

To ship an update: bump `version` in both `package.json` and
`sarvinbox-extension.json`, merge, tag `my-extension-v1.1.0`.

### From your own repository

You do not need anybody's permission to ship an extension. Copy
[`scripts/`](scripts) and [`.github/workflows/release.yml`](.github/workflows/release.yml)
into your own repository — they read `GITHUB_REPOSITORY`, so every URL they
generate points at wherever they are running — and publish your own index at
`https://raw.githubusercontent.com/<you>/<repo>/main/registry/index.json`.

A flat `registry.json` with the download block inline works too: the app still
reads that format and asks for no detail document when it finds one.

Users add it in Settings, Extensions, Registries. The app only accepts `https://`
URLs on `github.com` and `raw.githubusercontent.com`, verifies the pinned
SHA-256 exactly as it does for this registry, and shows the same permission
prompt before activating anything.

---

## Downloads, stars and ratings

There is no separate backend here — the numbers come from GitHub, which is also
what makes them independently checkable.

| Number | Where it comes from | Where it shows |
| --- | --- | --- |
| **Downloads** | `download_count`, summed across every `.tgz` asset of every release of that extension | Per extension in Browse, and the total in the badge above |
| **Stars** | `stargazers_count` on the repository | Next to the registry name in Browse |
| **Rating** | Not implemented — see below | Reserved in the schema |

`scripts/build-registry.mjs` writes both into the registry when it runs, so
they are available even when the app cannot reach the GitHub API. The app also
refreshes them live from the API with a cache, and falls back to the registry
values on a rate limit rather than showing nothing.

For your own README, shields.io reads the same numbers:

```markdown
[![Downloads](https://img.shields.io/github/downloads/OWNER/REPO/total?label=downloads)](../../releases)
[![Stars](https://img.shields.io/github/stars/OWNER/REPO?style=flat)](../../stargazers)
```

**Ratings.** GitHub has no review system, so there is nothing honest to read
five stars off. Rather than dress stars up as a rating, the registry schema
reserves `stats.rating` (0-5) and `stats.ratingCount`, and the app renders them
only when they are present. Filling them in needs a service that can accept a
review from a signed-in user and resist being stuffed — a real piece of work,
deliberately left undone rather than faked. Until then, stars and downloads are
what Browse shows.

---

## Permissions reference

The user sees this list before anything is activated, so ask for the least you
need. Permissions are **enforced**, not advisory: the app refuses the effect and
logs it once, it does not fail your workflow.

| Permission | Grants | Notes |
| --- | --- | --- |
| `email:read` | Subject, headers, body of a message you are handed | Nearly everything needs this |
| `email:label` | Adding and removing tags | Without it, returned `tags` are dropped |
| `email:flag` | Setting read / starred | Only these two sync to the server |
| `email:move` | Moving between folders | |
| `email:delete` | Deleting | Prompts the user separately |
| `ai:use` | `context.ai` | Costs the user tokens; say so in your description |
| `storage:local` | `context.storage` | Your own folder, no one else's |
| `network:fetch` | Outbound HTTP | Expect scrutiny in review |
| `settings:read` | Reading settings | |
| `settings:write` | Writing settings | Rarely justified |
| `ui:notify` | Notification cards | |

`answered`, `draft` and `deleted` are **always refused** regardless of
permissions: they carry IMAP meaning but have no sync path from an extension, so
allowing them would set a flag locally that the server never learns about, and
the next sync would quietly undo it.

---

## Registry format

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-22T10:00:00.000Z",
  "source": "https://github.com/Sarv/SarvInbox-extensions",
  "stats": { "stars": 0, "watchers": 0 },
  "extensions": [
    {
      "id": "otp-code",
      "name": "One-Time Passcodes",
      "version": "1.0.0",
      "description": "...",
      "author": "Sarv",
      "license": "MIT",
      "keywords": ["otp", "2fa"],
      "homepage": "https://github.com/Sarv/SarvInbox-extensions/tree/main/extensions/otp-code",
      "iconUrl": "https://raw.githubusercontent.com/.../icon.svg",
      "readmeUrl": "https://raw.githubusercontent.com/.../README.md",
      "engines": { "sarvinbox": "^1.1.0" },
      "permissions": ["email:read", "ui:notify"],
      "contributes": { "workflows": [], "settings": [] },
      "download": {
        "url": "https://github.com/.../releases/download/otp-code-v1.0.0/otp-code-1.0.0.tgz",
        "sha256": "64 hex characters",
        "size": 7104,
        "publishedAt": "2026-09-22T09:58:11Z",
        "releaseTag": "otp-code-v1.0.0"
      },
      "stats": { "downloads": 0 }
    }
  ]
}
```

An extension with no published release is left out rather than listed as
uninstallable — the registry describes what can be installed today.

The archive is **flat**: `sarvinbox-extension.json` and `dist/index.js` sit at
its root with no `package/` prefix, because the app extracts it straight into
the extension's install folder.

## Repository layout

```
extensions/            one folder per extension, each a pnpm workspace package
scripts/
  extension-paths.mjs  shared helpers: repo URLs, tag parsing, manifest reading
  pack-extension.mjs   build a release .tgz and its SHA-256
  build-registry.mjs   regenerate the registry from the published releases
  verify-bundle.mjs    require() every built bundle from a bare Node process
vendor/extension-sdk/  prebuilt SDK, checked in until it is published to npm
registry.json          the full registry, pretty-printed, for humans to review
registry/index.json    the thin index the app fetches
registry/e/<id>.json   per extension: download URL and pinned SHA-256
```

`vendor/extension-sdk` is temporary. The extensions depend on
`@sarvinbox/extension-sdk": "^1.0.0"` exactly as a third-party extension would,
and the root `package.json` redirects that range to the vendored copy with a
pnpm override. Once the package is on npm, delete the folder and the override.

## Licence

MIT — see [LICENSE](LICENSE).
