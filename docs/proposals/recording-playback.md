# Recording & Playback Proposal

This document outlines how to deliver the recording-sidecar and playback API described in the README while keeping the package highly composable. The approach mirrors the rest of the library: small primitives (schema helpers, stores, drivers, route adapters) that can be stitched together by the `manager()` convenience layer or consumed independently.

## Goals & Constraints
- Support multiple MediaMTX nodes that hot reload manager-driven configs.
- Keep MediaMTX isolated from the public internet; all ingest, recording, and playback control flows through the manager.
- Allow callers to mix-and-match storage adapters, hook generators, auth strategies, and state selectors.
- Provide a job-based recording pipeline that external sidecars can execute without privileged access to MediaMTX.
- Avoid breaking the existing `handler()`/`manager()` public API while making new building blocks standalone exports.

## Composition Principles
1. **Schema first** – extend the Zod schemas under `schema/mediamtx` plus new manager-level config schema so every layer stays type-safe.
2. **Pure state core** – expand `state/store.ts` into a deterministic state machine that describes nodes, paths, segments, and playback jobs. Persistence can stay in-memory for now; the interface should make storage pluggable later.
3. **Side-effect drivers** – implement storage, job queue polling, and hook routers as thin modules (similar to `busybox` and `auth`) that can be swapped out.
4. **Adapters at the edge** – Hono routers, hook command generators, and sidecar HTTP APIs live at the boundary and call into the core services via dependency injection.

## Architecture Overview

### Config & Schema Layer
- **Manager Config Schema**: introduce a new `ManagerConfig` that composes existing MediaMTX config with optional `storage`, `playback`, and `recording` sections. Export builders so app code can do:
  ```ts
  manager({
    config: mediamtxConfig({ ... }),
    storage: storage.s3(opts),
    playback: playback.jobs({ segmentLength: '5m', retention: '14d' })
  });
  ```
- **Global/Path schema updates**: ensure `runOnRecordSegmentCreate` and `runOnRecordSegmentComplete` are part of the default hook templates (they exist in `PathConfig` but are not configured). Extend `GlobalConfig` with playback server toggles if needed.

### State & Domain Layer
- **Entities**: `Node`, `Path`, `RecordingSegment`, `PlaybackJob`, `UploadTask`.
- **Events**: `segment_created`, `segment_completed`, `job_requested`, `job_assigned`, `job_uploaded`, `job_finalized`.
- **Selectors**: reuse the store’s `select` helper to expose derived views (e.g., per-path availability, outstanding jobs). This keeps downstream consumers reactive without manual event wiring.

### Storage Abstraction
- Create `storage/base.ts` that defines `StorageAdapter` with `putObject`, `headObject`, `signGet`, and `signPut` (for sidecar uploads).
- Implement `storage/s3.ts` mirroring the README example. Use the adapter to standardize object key generation (`recordings/{path}/{segmentId}.mp4`).
- Allow the manager to accept either a synchronous adapter or a builder that uses env credentials at runtime (helps Workers/edge deployments).

### Recording Pipeline & Hooks
1. Extend `busybox` command generator (and future generators) to include `runOnRecordSegmentCreate/Complete` POSTs that forward MediaMTX metadata.
2. Add new handlers under `/hooks/segments` that:
   - validate auth + payload shape via Zod,
   - store raw segment metadata in the state store,
   - emit `segment_created`/`segment_completed` events.
3. Provide a `recording` service that listens to the store and automatically enqueues `PlaybackJob` items when segments covering a requested time range exist.

### Playback Job Service & API
- Create `services/playback.ts` exporting a factory that accepts `{ store, storage, clock }` and returns methods:
  - `requestClip(path, { start, duration })`
  - `getJob(jobId)`
  - `assignNextJob(nodeId)` (for sidecars)
  - `completeJob(jobId, result)`
- The public `mediamtx.playback.get()` helper simply forwards to `requestClip` and returns job metadata plus a signed URL when ready.

### HTTP Routes & Sidecar Protocol
- Add a `/playback` router (parallel to existing `/config` helper) with endpoints:
  - `POST /playback/requests` – client-requested clips.
  - `GET /playback/jobs` – sidecar polls with `node` query; returns one job.
  - `PUT /playback/jobs/:id` – sidecar uploads status + optional storage location.
  - `GET /playback/jobs/:id` – clients poll for completion / receive final download URL.
- Reuse existing auth hook to guard all routes so deployments can enforce RBAC on `playback.request` vs `playback.worker` actions.

### Sidecar Integration
- Define a small TypeScript interface (exported) describing the playback worker loop so the standalone Docker image can share types if we publish them.
- Workers authenticate using the same shared key scheme already demonstrated (`Authorization: Bearer KEY`).
- Workers call the API in this order: fetch job → upload clip to provided pre-signed PUT URL (or via local ffmpeg + storage.key) → report completion/backfill metadata.

### Client Experience
- The `manager()` helper should expose `.playback` with at least:
  - `get(path, { start, duration })`
  - `status(jobId)`
  - `subscribe(onUpdate)` for UI dashboards (fed by the store).
- Everything should compose from primitives so advanced users can bypass `manager()` and wire `services/playback` directly into custom routers.

## Implementation Phases
1. **Scaffolding**: define schemas/types, storage adapter interfaces, update hook generators.
2. **State Core**: implement store entities/events plus pure helpers for segment → job inference.
3. **Services & APIs**: build playback service and Hono routes; ensure `manager()` composes them.
4. **Sidecar Contract**: finalize polling/upload protocol and document expected env vars (NODE, KEY, STORAGE_BUCKET, etc.).
5. **Polish & Testing**: add unit tests around the store/service, smoke-test Hono routes, document flows in README/examples.

## Testing & Observability
- Add unit tests for store reducers (segment + job lifecycle), using deterministic clocks.
- Add contract tests for the playback service to cover overlapping requests, multi-node assignment, retry, and expiration.
- Provide structured logs for all route handlers (scope, jobId, node, latency) so operators can plug into log drains.
- Leverage store selectors to expose metrics-friendly snapshots (counts of queued jobs, per-node throughput) that can be scraped by the manager’s host.

---
This proposal keeps every layer modular: schema + store + services + adapters. Higher-level helpers such as `manager()` or the Hono adapter merely assemble these pieces, matching the composition style already present in the repository.
