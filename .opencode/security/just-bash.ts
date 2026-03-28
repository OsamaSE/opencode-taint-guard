import path from "node:path"

type JustBashResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export async function runJustBash(input: {
  sessionID: string
  worktree: string
  command: string
  signal: AbortSignal
  networkEnabled: boolean
}): Promise<JustBashResult> {
  const runnerPath = path.join(input.worktree, ".opencode", "security", "just-bash-runner.mjs")
  const payload = Buffer.from(
    JSON.stringify({
      sessionID: input.sessionID,
      worktree: input.worktree,
      command: input.command,
      networkEnabled: input.networkEnabled,
    }),
    "utf8",
  ).toString("base64")

  const subprocess = Bun.spawn(["node", runnerPath, payload], {
    cwd: input.worktree,
    env: process.env,
    signal: input.signal,
    stdout: "pipe",
    stderr: "pipe",
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      subprocess.kill()
    } catch {
      // noop
    }
  }, 15000)

  const [stdout, stderr, exitCodeRaw] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ])

  clearTimeout(timer)

  const exitCode = Number.isInteger(exitCodeRaw) ? exitCodeRaw : 1
  const timeoutMessage = "just-bash timed out after 15000ms"
  const finalStderr = timedOut && !stderr.includes(timeoutMessage)
    ? `${stderr}${stderr.endsWith("\n") || !stderr ? "" : "\n"}${timeoutMessage}\n`
    : stderr

  return {
    stdout,
    stderr: finalStderr,
    exitCode,
  }
}
