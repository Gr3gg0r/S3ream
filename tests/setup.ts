/**
 * Vitest global setup. Runs once per test file before the suite, so each
 * file gets its own isolated Electron `userData` directory — important for
 * the historyService singleton, which resolves its storage path from
 * `app.getPath("userData")` at module import time.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.S3REAM_TEST_USER_DATA) {
  process.env.S3REAM_TEST_USER_DATA = mkdtempSync(join(tmpdir(), "s3ream-test-userdata-"));
}
