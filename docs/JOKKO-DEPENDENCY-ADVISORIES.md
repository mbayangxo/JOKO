# Dependency advisories: triage (A6)

`npm audit --omit=dev` on 2026-10-09.

- **Before:** 31 high, 13 moderate, 0 critical.
- **After `npm audit fix` (no `--force`, no major change):** **20 high, 8 moderate, 0 critical**.

The lockfile change was verified by the web build (`expo export --platform web`: OK), the J9 suites, and then the full fresh-DB gate (J10 report).

## How reachability was assessed
1. **Deployed server (`/api` on Vercel):** only what `lib/` and `api/` import. That is `zod`, `jsonwebtoken`, `bcryptjs`, `stripe`, `livekit-server-sdk`, `@vercel/blob`, `@sentry/node` and `@prisma/client`, plus `node:` built-ins (checked with a grep of every import).
2. **Shipped web / mobile bundle:** what `src/` pulls in at runtime.
3. **Build and developer tooling:** Expo CLI, Metro, Babel/PostCSS, the Prisma CLI. These run on a developer machine or in the build step on our own inputs, and never on user input in production.

## Fixed by this change (within semver ranges)

| Package | Advisory | Reachable? | Status |
|---|---|---|---|
| `undici` 6.27 → **6.29** | retry-interceptor desync; CRLF injection via a blob `type` | **server**, through `@vercel/blob` (Mbolo video upload tokens). We never pass user-controlled blob types, but it is on the runtime path, so this was the priority. | **fixed** |
| `nanoid` | infinite loop with a non-positive size | client (react-navigation) with constant sizes; not attacker-controlled | fixed |
| `compression`, `browserslist`, `postcss`, `source-map-js`, `js-yaml`, `@xmldom/xmldom`, `brace-expansion`, `image-size` (partly) | DoS / file-disclosure in build tooling | build-time only, on our own source | fixed where in range |

## Remaining 20 high: all build or developer tooling, none on the server runtime path

| Group | Packages | Why not reachable in production | Fix path |
|---|---|---|---|
| Expo CLI / Metro bundler | `expo`, `@expo/cli`, `@expo/metro*`, `metro*`, `micromatch`, `braces`, `image-size`, `node-forge`, `@expo/code-signing-certificates` | They run only during `expo start` / `expo export` on our repository. `node-forge` signature verification is used for Expo Updates code signing, which we do not use. | `npm audit` proposes `expo@44` (a **downgrade**). That is wrong; the fix is the next Expo SDK patch release. Track the Expo 57.x patches and re-audit on each SDK bump. |
| React Native packages | `react-native`, `@react-native/community-cli-plugin`, `@react-native/virtualized-lists` | flagged **only** through Metro (dev server / CLI), not through runtime code | same: the RN patch that ships with the Expo SDK |
| `@sentry/react-native` | through `expo` | the same Expo chain | follows the Expo bump |
| Prisma CLI | `prisma`, `@prisma/config`, `deepmerge-ts` | `prisma.config` loading at CLI time (generate / migrate) on our own config; the runtime `@prisma/client` is **not** flagged | proposed `prisma@6.12` is a downgrade; take the next 6.x patch that bumps `deepmerge-ts` ≥ 8 |

## Mitigations while they remain
- **Never run the Expo dev server or Metro exposed to an untrusted network.** The CI / Vercel build uses `expo export` only.
- **Build inputs are our own repository.** No user-supplied config, YAML, globs or source maps are processed by these tools.
- **Server-side monitoring:** re-run this triage and `npm audit --omit=dev --audit-level=critical` in each gate (it is a gate check). Any advisory on a server-runtime package (the list in "How reachability was assessed") is treated as priority and fixed before release.

## Not covered by `npm audit`
- **API request body cap (implemented in A6):** `prepareApiBody` now keeps at most `API_MAX_BODY_BYTES` (default 2 MB). Past the cap it drains the rest without keeping it, and the API answers **413 `payload_too_large`** before any handler runs. Before this, only Vercel's 4.5 MB platform cap bounded it. Test: `tests/j9/evidence-files.test.js`.
