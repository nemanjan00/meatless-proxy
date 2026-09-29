# @mp/sandbox

Code execution for employees (L3): stateful Python and Node kernels, one per session and language, in a
sandbox container per employee, with the employee's files at hand. Behind `code.run` and `code.reset`
(`@mp/stdlib`).

## API

- `createSandbox({ runtime, files, image, clock?, logger?, filesVolume?, user?, limits?, egress?, idleMs?, reapIntervalMs?,
  maxOutputChars?, maxFileBytes?, nameFor? })` returns a `Sandbox`:
  - `run({ employeeId, sessionId, language: 'python' | 'node', code, timeoutMs?, fresh?, signal?, actor? })` →
    `{ stdout, stderr, result?, error?, files_changed, duration_ms, state_lost?, notes? }`.
  - `reset(sessionId, language?)`, `endSession(sessionId)`, `hasSession(sessionId)`, `reapIdle()`, `close()`, `mode()`.
- `Kernel` (one interpreter over `ContainerRuntime.spawn`), `kernelCommand`, `LANGUAGES`.
- `mountWorkspace` / `copyWorkspace`: the two ways files get into the sandbox, behind the `Workspace` interface.
- `PYTHON_DRIVER`, `NODE_DRIVER`, `MANIFEST_SCRIPT`, `FRAME_MARK`: the programs run inside the container.
- `sandboxName(base, employeeId)`, `truncate(text, max, total?)`, `LABEL_SANDBOX`, `LABEL_MOUNTS`, the defaults.
- `fakeSandboxRuntime({ storage?, features?, ... })`: a `fakeRuntime` whose kernels speak the protocol and run cells as
  JavaScript in the test process, with `print`, `write`, `read`, `remove`, `sleep`, `hang`, `die`, `raw` and `rawErr`
  helpers. For tests only.

## How it works

- **Container.** One per employee, `mp-<name>-sandbox` (`nameFor`, e.g. the employee's handle), from `image`: user
  `1000:1000` by default, read-only root, a fresh volume at `/work` and a tmpfs at `/tmp`, CPU, memory and pids limits, no
  environment variables (no secrets), no host paths. No network unless `egress` (a list, or a function of the employee:
  the server gives its network setting, else `DEFAULT_EGRESS`) names hosts, which then go through the runtime's
  allowlisting egress proxy. A changed list recreates the container at its next idle run. Labelled `mp.sandbox=<employeeId>` and with the signature of its file mounts. A
  container that stopped is recreated on the next run; ones left by an earlier process are removed first (their kernels
  and copied files are unknown).
- **Kernels.** A driver (`python3 -u -c PYTHON_DRIVER` or `node --expose-internals -e NODE_DRIVER`) reads one JSON
  request per line on stdin and answers with a frame on stdout, `\x1e<token>{json}\n`. Python cells run in one globals dict
  (the last expression's `repr` is the result, top-level `await` works, tracebacks show the cell's lines); Node cells run
  in one `vm` context (the completion value is the result; top-level `await` goes through Node's own REPL transform, so
  `const` and `let` persist). `print` and `console.log` are captured and capped in the driver; what subprocesses write to
  the descriptors arrives as raw output around the frames. Cells of one session run one at a time.
- **Timeouts** (default 30 s, clamped to 1 s .. 5 min) and aborts kill the kernel (and its process group); the result says
  the state is lost. A kernel that dies (e.g. out of memory, exit 137) is reported the same way and restarted on the next
  run. `fresh` runs in a throwaway kernel. Idle kernels, then idle containers, are stopped after `idleMs` (15 min); a
  session that ends (`done`, `abandoned`) loses its kernels.
- **Files: mount mode** (`filesVolume` set, storage with `localPath`, runtime `features().volumeSubpath`). The files volume
  holds `FileStorage`'s root, so the container mounts `<volume>/<employeeId>` at `/work/files` and each live grant's path
  at `/work/shared/<owner>/<path>` (read-only, or read-write for a write grant). Nothing is copied. `files_changed` comes
  from a before-and-after walk (size and modification time) of the employee's files and the write-shared paths. When the
  grants change, the container is recreated at the next run once no other cell is running in it, with a note.
- **Files: copy mode** (the fallback). Before a cell, files whose modification time changed since the last sync are copied
  into `/work/files` (owned by the sandbox user) and files deleted since are removed; after it, a manifest of `/work/files`
  (before and after) shows what the cell created, changed and deleted, which is written back to storage (deleting only
  what nobody changed meanwhile). Files over `maxFileBytes` (25 MB) are skipped with a note. Shares are root-owned,
  read-only copies under `/work/shared`, rebuilt when a grant or a shared file changes.
- Every change is published through `files.notifyChanged` (`file.changed`), with the session as the actor.

## Tests

`test/sandbox.test.ts` with `fakeSandboxRuntime`: state across cells, the container spec, egress, node, timeouts, dead
kernels, fresh kernels, concurrent cells of one session, isolation between sessions and employees, truncation, raw output,
idle reaping, reset and session ends, dead and leftover containers, validation; copy mode (sync both ways, incremental
copies, deletes on both sides, read-only shares, size limits, a file changed meanwhile) and mount mode (the mounts, direct
writes, write and read-only shares, recreation when grants change, waiting for busy sessions). The real image is tested in
`packages/server/test/sandbox-docker.test.ts` (`MP_DOCKER_TEST=1`).

## Replacing it

Another `Sandbox` (Firecracker, a remote kernel service) with the same `run`/`reset` contract; the stdlib tools only use
the interface. A new file transport is another `Workspace`.
