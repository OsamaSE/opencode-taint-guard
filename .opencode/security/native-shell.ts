type NativeShellResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export async function runNativeShell(input: {
  command: string
  cwd: string
  signal: AbortSignal
}): Promise<NativeShellResult> {
  const subprocess = Bun.spawn(["/bin/bash", "-lc", input.command], {
    cwd: input.cwd,
    env: process.env,
    signal: input.signal,
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ])

  return {
    stdout,
    stderr,
    exitCode,
  }
}

export function formatShellResult(input: NativeShellResult & { route: string; networkEnabled?: boolean }): string {
  const sections = [
    `route: ${input.route}`,
    `network: ${input.networkEnabled ? "enabled" : "disabled"}`,
    `exit_code: ${input.exitCode}`,
    "stdout:",
    input.stdout || "",
    "stderr:",
    input.stderr || "",
  ]
  return `${sections.join("\n")}\n`
}
