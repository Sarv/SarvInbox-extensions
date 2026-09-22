# Vendored SDK

This is a prebuilt copy of [`@sarvinbox/extension-sdk`](https://www.npmjs.com/package/@sarvinbox/extension-sdk),
checked in so this repository builds before that package is published to npm.

The extensions here depend on `@sarvinbox/extension-sdk": "^1.0.0"` exactly as a
third-party extension would; the root `package.json` redirects that range to
this folder with a pnpm override.

**Once the package is live on npm, delete this folder and the `pnpm.overrides`
entry in the root `package.json`.** Nothing else has to change.
