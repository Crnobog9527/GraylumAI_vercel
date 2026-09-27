/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Disposable local/CI service images, pinned to the multi-platform index digests
// these integration tests were verified against. Update tag and digest together.
export const POSTGRES_IMAGE = "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
export const POSTGREST_IMAGE = "public.ecr.aws/supabase/postgrest:v14.13@sha256:488093de819567422bc1d37cb79da6e84bca3726bac321daeed618f0ed957888";
export const GOTRUE_IMAGE = "public.ecr.aws/supabase/gotrue:v2.190.0@sha256:f106c022ebb1362d733a52711a32b25ba4a8757e460f56da843d9521d4515d4e";
