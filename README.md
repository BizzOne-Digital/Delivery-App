# Delivery App — backend

Express + TypeScript + MongoDB (Mongoose) + Socket.IO.

See the [root README](../README.md) for the full picture. This file covers backend specifics.

## Setup

```bash
npm install
npm run dev              # http://localhost:5001 — talks to Atlas
```

`MONGODB_URI` in `.env` already points at the Atlas cluster, database `delivery-app`, and it is
seeded. Re-run `npm run seed` (or `npm run seed:reset`) for fresh demo data.

**Offline alternative:** `npm run mongo` starts a local MongoDB using the `mongod` binary that
`mongodb-memory-server` downloads for the test suite, storing data in `.mongodb-data/` so it
survives restarts. Point `MONGODB_URI` at `mongodb://127.0.0.1:27017/delivery-app` to use it.

**Rotate the Atlas password before production** — the current one was shared over chat.

**Port note:** the API defaults to **5001** locally because macOS Control Centre (AirPlay Receiver)
occupies port 5000. Disable AirPlay Receiver if you want 5000 back.

### `EADDRINUSE: address already in use :::5001`

Another `npm run dev` is still running (often in a closed terminal tab). The server now prints the
fix, but for reference:

```bash
lsof -ti:5001 | xargs kill -9
```

Note there is **no space** after `-i` — `lsof -ti :5001` is a syntax error. To sidestep it entirely,
start on a different port: `PORT=5002 npm run dev`.

**`.env` note:** quote any value containing `#`. dotenv reads an unquoted `#` as the start of a
comment and truncates the value — `SEED_PASSWORD="JustDelivery#2026"` is quoted for that reason.
Inside a MongoDB URI, percent-encode it as `%23`.

## Environment

| Variable | Required | Notes |
| --- | :-: | --- |
| `MONGODB_URI` | ✅ | Atlas connection string. Database **must** be `delivery-app`. Startup fails loudly if it is missing or still the placeholder. |
| `MONGODB_DB_NAME` | | Defaults to `delivery-app`; also forced via `dbName` so a URI without a path still lands correctly. |
| `PORT` | | Default `5000`; set to `5001` in the local `.env` because macOS AirPlay Receiver occupies 5000. |
| `NODE_ENV` | | `development` \| `test` \| `production`. |
| `JWT_ACCESS_SECRET` | ✅ | ≥16 chars. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `JWT_REFRESH_SECRET` | ✅ | Must differ from the access secret. |
| `JWT_ACCESS_EXPIRES_IN` | | Default `15m`. |
| `JWT_REFRESH_EXPIRES_IN` | | Default `30d`. |
| `CLIENT_URL` | | Comma-separated CORS allow-list. |
| `UPLOAD_BASE_URL` | | Public base for generated file URLs. |
| `STORAGE_DRIVER` | | `local` (disk, dev) \| `memory` (serverless-safe, ephemeral). |
| `UPLOAD_MAX_FILE_SIZE_MB` | | Default `8`. |
| `SEED_PASSWORD` | for seeding | Password given to every demo account. Never hard-coded. |
| `TRACKING_TOKEN_SECRET` | ✅ | Signs public patient tracking links. |
| `TRACKING_TOKEN_TTL_HOURS` | | Default `48`. |
| `PUSH_/SMS_/EMAIL_PROVIDER` | | `dev` (simulated) until real adapters are implemented. |
| `RATE_LIMIT_*` | | Window and ceilings for the limiter. |

## Connecting to MongoDB Atlas

1. <https://cloud.mongodb.com> → your project → **Database → Connect → Drivers**.
2. Copy the `mongodb+srv://…` string and append the database name: `…mongodb.net/delivery-app`.
3. Percent-encode special characters in the password (`@` → `%40`, `#` → `%23`, `/` → `%2F`).
4. **Network Access → ADD IP ADDRESS → ADD CURRENT IP ADDRESS.** Wait for it to become *Active*.
   Deploying to Vercel needs `0.0.0.0/0` because function IPs are dynamic.
5. `npm run seed` — the database, collections and indexes are created on first write.

Connection failures are translated into actionable messages rather than raw driver errors:
DNS failures, bad auth and IP-whitelist timeouts each print exactly what to do (including the
step-by-step Network Access instructions).

## Scripts

```bash
npm run dev          # tsx watch, realtime enabled
npm run build        # tsc → dist/
npm start            # node dist/server.js
npm run seed         # add demo data (skips what exists)
npm run seed:reset   # wipe the seeded collections first
npm run lint         # ESLint (0 errors, 0 warnings)
npm run typecheck    # tsc --noEmit
npm test             # 80 Jest + Supertest tests on an in-memory MongoDB
```

`npm test` never touches your Atlas cluster — `mongodb-memory-server` spins up a throwaway instance.

## Architecture notes

**Atomic order claiming** (`src/services/order.service.ts`)

```ts
Order.findOneAndUpdate(
  { _id, status: 'READY', claimedAt: null,
    $or: [{ assignedDriverId: null }, { assignedDriverId: driverId }] },
  { $set: { assignedDriverId: driverId, claimedAt: now, status: 'ON_THE_WAY' }, … },
  { new: true },
)
```

MongoDB applies `findOneAndUpdate` atomically at the document level, so two concurrent claims cannot
both match the filter — no transaction, no read-then-write gap. The loser gets `null` back and the
service works out *why* to produce a useful 409 ("Jamal Whitfield took this order first"). This is
covered by tests that fire 2 and 5 simultaneous claims.

**Serverless-safe connection** (`src/config/db.ts`) — the mongoose promise is cached on `globalThis`
so a warm lambda reuses its socket instead of opening a new pool per request.

**Pluggable adapters** — routing, storage and notifications are all interfaces with a documented
development implementation and inline instructions for swapping in the real thing. Each one reports
its true capabilities through `/api/v1/health` so the UI never overstates what is running.

**Redacting logger** (`src/config/logger.ts`) — passwords, tokens, secrets and anything matching a
MongoDB URI are replaced before a line is written.

## Tests

```
tests/auth.test.ts             login, no user-enumeration, disabled accounts,
                               refresh rotation + reuse detection, change password
tests/orders.claim.test.ts     atomic claim, 2- and 5-way races, batch claiming,
                               Ready visibility per assignment mode
tests/orders.lifecycle.test.ts completion + proof enforcement, failure, returning,
                               back-to-delivery, cancellation-via-returning, edit locks
tests/rbac.test.ts             pharmacy isolation, role gates, READ_ONLY, deactivation
                               guard, public tracking privacy
tests/units.test.ts            geo, CSV (incl. formula-injection), pagination, dates,
                               status transitions, route optimiser, recurrence
```

## Deploying to Vercel

`api/index.ts` exports the Express app; `vercel.json` rewrites everything to it.

Two caveats, both handled in code and documented in the root README: **Socket.IO cannot run on
serverless** (the client falls back to polling and says so), and **the filesystem is read-only**
(use `STORAGE_DRIVER=memory` or an S3/Cloudinary adapter).

For full realtime, deploy this same code to a persistent host instead:

```bash
npm run build && npm start
```
