// Preloaded into every test process by scripts/run-tests.ts (`--import`): a test
// file's own console output goes to stderr, never to stdout.
//
// Under `node --test` a test file's stdout is also the channel its results
// travel on, as v8-serialized messages. Node 22's parser
// (internal/test_runner/runner.js, #processRawBuffer) assumes the bytes right
// after a message start the next one. When a plain line lands in the same read
// as the message before it, it reads that line's bytes 2 to 5 as the next
// message's size. A line whose third byte is 0x80 or above (a run-log line
// opening with ✔, ━━ or "  …", music/run-log-format.ts) gives a negative size,
// and the file fails with "Unable to deserialize cloned data due to invalid or
// unsupported version" though every test in it passed. An ASCII line gives a
// size too large to wait for and is read as text a moment later, so the bug
// stayed hidden until the run log printed its marks. It needs a busy host to
// coalesce the two writes, hence a flake that shows up under `--jobs`.
//
// stderr carries no messages, so nothing on it is parsed. Only in a test
// file's own process (NODE_TEST_CONTEXT=child-v8): the runner's output stays
// on stdout. A test that captures `console.log` still does, since it patches
// the console this sets.
import { Console } from 'node:console';

if (process.env.NODE_TEST_CONTEXT === 'child-v8') {
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
}
