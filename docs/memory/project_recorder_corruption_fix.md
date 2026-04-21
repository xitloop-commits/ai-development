---
name: Recorder gzip corruption fix (2026-04-21)
description: NdjsonGzWriter had no cross-process lock, causing "invalid block type" corruption in every raw .ndjson.gz from 2026-04-14 through 2026-04-20. Fixed + recovery pass run.
type: project
originSessionId: e9b47b10-0d15-43ee-b09b-d2492cad3bfb
---
# NdjsonGzWriter corruption root-cause + fix

**Discovered:** 2026-04-20 night. TFA replay of 2026-04-20 naturalgas + crudeoil
emitted `REPLAY_READ_ERROR ... Error -3 while decompressing data: invalid block
type` warnings on all three stream files (underlying / option / chain).

**Scope:** Not just that night. A sweep of `data/raw/` showed **every full-session
`.ndjson.gz` from 2026-04-14 through 2026-04-20 was corrupt** with the same zlib
error mid-stream. Only small files (e.g. 2026-04-16 NSE, ~3 MB) decompressed
cleanly. 28 of 60 files were unrecoverable past some point; 5 were totally
unreadable.

**Why:** [python_modules/tick_feature_agent/recorder/writer.py](python_modules/tick_feature_agent/recorder/writer.py)
used `gzip.open(path, "at")` protected by only a `threading.Lock` — which is
per-process. If two TFA processes for the same instrument ever wrote to the
same file (duplicate bat launch, restart race on exit-75, etc.), their gzip
byte streams interleaved and the decoder saw "invalid block type" wherever
the bytes met.

**How to apply:**
- Any new tick-recorder / raw-data writer must take an **OS-level exclusive
  lock** on the target file, not just a Python lock. The project now uses a
  sidecar `<path>.lock` via `msvcrt.locking` on Windows and `fcntl.flock` on
  POSIX (see `_FileLock` in writer.py).
- Writer `__init__` raises `WriterLockError` if the lock can't be acquired —
  **do not catch and retry silently**. The explicit failure tells the user
  "another TFA is already writing here" instead of producing corrupted data.
- When reviewing any future append-mode compressor (gzip/zstd/lz4) in this
  project, check for the same pattern.

**Recovery artifacts:** [scripts/recover_gz.py](scripts/recover_gz.py) stream-
reads each corrupt file up to the first zlib error, trims to the last `\n`,
and re-gzips the prefix as `*.recovered.ndjson.gz` next to the original.
Originals kept untouched. Re-runnable; idempotent.

**Follow-ups when the user returns:**
- Decide whether replay pipelines should prefer `.recovered.ndjson.gz` over
  the corrupt originals when both exist (replay currently reads only the
  canonical filename, so partial data recovered on historical dates is not
  yet being used).
- Delete the corrupted originals once the recovered versions are proven
  sufficient.
