/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local website previews only; deliberately separate from the CI-only images.mjs manifest.
// --without-app CI does not pull or start these services.
// Upstash's recommended local REST adapter: https://upstash.com/docs/redis/sdks/ts/developing
// Docker Hub index digests read 2026-09-29 via `docker buildx imagetools inspect <tag>`.
// SRH: community project (MIT); Redis 7.2: Redis LTD official image (BSD-3-Clause Redis source).
export const REDIS_IMAGE = "redis:7.2-alpine@sha256:29e8589c3f9ba699b5f7aa4b3c7733c58852a3626439e619aa0ee78de08c6ca0";
export const SRH_IMAGE = "hiett/serverless-redis-http:0.0.10@sha256:65128347949bca511e448fd7238780d624573d74c22b79155a7563db19e9b678";
