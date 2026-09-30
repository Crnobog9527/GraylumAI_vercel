-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Deliberately leave an erased row; the next rollback script MUST refuse atomically.
SELECT account_erasure_scrub_runtime(id) FROM profiles WHERE nickname='b1b-closed';
