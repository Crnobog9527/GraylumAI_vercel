/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Disposable local/CI service images, pinned to the multi-platform index digests
// these integration tests were verified against. Update tag and digest together.
// Supabase images come from GHCR: the same index digests as public.ecr.aws,
// whose anonymous pull quota is exhausted on shared GitHub runner addresses.
export const POSTGRES_IMAGE = "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
export const POSTGREST_IMAGE = "ghcr.io/supabase/postgrest:v14.13@sha256:488093de819567422bc1d37cb79da6e84bca3726bac321daeed618f0ed957888";
export const GOTRUE_IMAGE = "ghcr.io/supabase/gotrue:v2.190.0@sha256:f106c022ebb1362d733a52711a32b25ba4a8757e460f56da843d9521d4515d4e";
// Upstash's recommended local REST adapter: https://upstash.com/docs/redis/sdks/ts/developing
// Docker Hub index digests read 2026-09-29 via `docker buildx imagetools inspect <tag>`.
// SRH: community project (MIT); Redis 7.2: Redis LTD official image (BSD-3-Clause Redis source).
export const REDIS_IMAGE = "redis:7.2-alpine@sha256:29e8589c3f9ba699b5f7aa4b3c7733c58852a3626439e619aa0ee78de08c6ca0";
export const SRH_IMAGE = "hiett/serverless-redis-http:latest@sha256:5b0bb9239fce53abf87b2018a7a0deb9ec7bd900c5360738fe5fbeeb426f9150";
