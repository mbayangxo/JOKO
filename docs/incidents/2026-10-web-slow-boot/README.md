# Production defect (availability, web): the app never leaves the loading screen on slow connections

| State | Status |
|---|---|
| Found | 2026-10-13, J12 weak-network lab (**simulated**: Chromium + DevTools emulation) |
| Severity | Availability of the **web** app for users on 2G/slow 3G. **No money and no data risk.** The native app bundles its fonts and is not affected. |
| Production patched | **NO**. Patch prepared and verified locally only. **Deployment not authorized.** |
| Separate package | Yes. Never bundled with P0-B, F1, J11 or J12. |

## What happens
- The web app waits for its custom fonts before rendering (`App.js`: `if (!fontsLoaded)` shows the K21 loading screen).
- On web, `expo-font` gives up after about **3 s** (FontFaceObserver timeout) and reports an error. `fontsLoaded` then **never** becomes `true`.
- On any connection where the fonts take longer than about 3 s, the user sees the K21 loading screen **forever**.

## Evidence (local, production base `b0318b5`, emulated 2G: 280 kbps, 800 ms RTT)

| Build | Result |
|---|---|
| `b0318b5` as deployed | **still on the loading screen after 240 s** (no API call ever made) |
| `b0318b5` + `web-slow-boot-b0318b5.patch` | home screen visible after **39 s** |
| The J12 branch, same fix (`b50f557`) | home after 77 s; also recovers automatically from an interrupted bundle download (J12-F15) |

## Patch
- **File:** `web-slow-boot-b0318b5.patch` (sha256 prefix `619dc51596bc67f4`). One file, `App.js`, +10/−2.
- **Change:** start with system fonts when the custom fonts have failed, or after 10 s at the latest. The custom fonts are applied when they arrive.
- **Scope:** no API, schema, environment or money change. The web export build passes.

## Deploy plan (only with verified Vercel access and explicit authorization)
1. Branch from `b0318b5`, apply the patch, build a preview.
2. Check the preview with a throttled browser (DevTools "Slow 3G"): the home screen must appear.
3. Promote to production as its own deployment.
4. Do not roll back to `7d262de`: it contains the P0-A vulnerability.
