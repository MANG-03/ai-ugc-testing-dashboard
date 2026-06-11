# Echoes web — setup

Next.js 16 + Convex. Phase 1 = upload a source video → run Pegasus TBM → see the scene breakdown.

## ⚠️ Local vs Cloud deployment (important)

`npx convex dev` with no account creates a **local** deployment at `127.0.0.1:3210`. That's great for
UI work, but its `storage.getUrl()` links are `http://127.0.0.1/...` — **external APIs (Twelve Labs,
EvoLink) cannot fetch localhost**, so **Pegasus analysis and generation will not work on a local
deployment.** For anything that calls those APIs you need a **cloud** deployment:

```bash
npx convex login      # one-time, opens browser to link a (free) Convex account
npx convex dev        # now provisions a CLOUD dev deployment → public files.convex.cloud URLs
```
Then re-set the keys on the cloud deployment (env vars are per-deployment — see step 2 below).

## One-time setup

From `dashboard/web`:

1. **Start Convex** — use a CLOUD deployment (see above) if you want Pegasus/generation to work.
   This generates `convex/_generated/` and writes `NEXT_PUBLIC_CONVEX_URL` into `.env.local`. Leave it running:
   ```bash
   npx convex login && npx convex dev
   ```
   > Nothing typechecks until this runs once — the `convex/_generated` API types don't exist yet.

2. **Set the API keys on the Convex deployment** (these power the server-side actions; never put them
   in client env). In another terminal, from `dashboard/web`:
   ```bash
   npx convex env set TWELVELABS_API_KEY tlk_19K1MKF3R6CKRZ23RG7PT3GQWQQJ
   npx convex env set EVOLINK_API_KEY sk-Obd25gOOoIUpUkKcdQPUWUF7isi2kk0dtduzMW57I2i0QAJE
   ```
   (Only `TWELVELABS_API_KEY` is needed for Phase 1; EvoLink is for later phases.)

3. **Run the app** (keep `npx convex dev` running in its terminal):
   ```bash
   npm run dev
   ```
   Open http://localhost:3000.

## What works now (Phase 1)
- Drag/drop or pick a video → uploads to Convex file storage.
- "Run Pegasus Analysis" → server action calls Twelve Labs TBM on the Convex `getUrl()` link,
  polls to completion, stores the result, and the scene breakdown renders live.

## Notes
- The other three views (Generation Studio, Experiment History, Prompt Skills) are stubs — next phases.
- Convex `getUrl()` links are public + permanent (unguessable UUID) — that's intentional; it's how
  external APIs (Twelve Labs now, Seedance/Kling later) fetch the media.
