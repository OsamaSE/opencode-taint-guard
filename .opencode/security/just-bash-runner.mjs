import { mkdirSync } from "node:fs"
import path from "node:path"
import { Bash, InMemoryFs, MountableFs, OverlayFs, ReadWriteFs } from "just-bash"

const encodedPayload = process.argv[2]

if (!encodedPayload) {
  process.stderr.write("missing payload\n")
  process.exit(1)
}

const payload = JSON.parse(Buffer.from(encodedPayload, "base64").toString("utf8"))
const worktree = payload.worktree
const sessionID = payload.sessionID
const command = payload.command
const networkEnabled = Boolean(payload.networkEnabled)

const scratchRoot = path.join(worktree, ".opencode", "runtime", "just-bash", sessionID)
mkdirSync(scratchRoot, { recursive: true })

const fs = new MountableFs({
  base: new InMemoryFs(),
})

fs.mount("/workspace", new OverlayFs({ root: worktree, mountPoint: "/" }))
fs.mount("/scratch", new ReadWriteFs({ root: scratchRoot }))

const bash = new Bash({
  fs,
  cwd: "/workspace",
  env: {
    HOME: "/scratch",
    TMPDIR: "/scratch/tmp",
  },
  python: true,
  javascript: true,
  network: networkEnabled
    ? {
        dangerouslyAllowFullInternetAccess: true,
      }
    : undefined,
})

const result = await bash.exec(command, {
  cwd: "/workspace",
  signal: AbortSignal.timeout(12000),
})

if (result.stdout) {
  process.stdout.write(result.stdout)
}

if (result.stderr) {
  process.stderr.write(result.stderr)
}

process.exit(result.exitCode)
