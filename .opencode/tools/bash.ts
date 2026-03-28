import { tool } from "@opencode-ai/plugin"
import { runJustBash } from "../security/just-bash"
import { formatShellResult, runNativeShell } from "../security/native-shell"
import { getSessionState } from "../security/state"

export default tool({
  description:
    "Execute shell commands. Uses the host shell until the session reads untrusted web data, then routes commands through just-bash.",
  args: {
    command: tool.schema.string().describe("Shell command to execute"),
  },
  async execute(args, context) {
    const state = getSessionState(context.sessionID)

    if (!state.sawUntrusted) {
      const result = await runNativeShell({
        command: args.command,
        cwd: context.directory,
        signal: context.abort,
      })
      context.metadata({
        title: "native bash",
        metadata: {
          route: "native",
          sawUntrusted: state.sawUntrusted,
          sawSecret: state.sawSecret,
          networkEnabled: true,
        },
      })
      return formatShellResult({
        ...result,
        route: "native-bash",
        networkEnabled: true,
      })
    }

    const networkEnabled = !state.sawSecret
    const result = await runJustBash({
      sessionID: context.sessionID,
      worktree: context.worktree,
      command: args.command,
      signal: context.abort,
      networkEnabled,
    })
    context.metadata({
      title: networkEnabled ? "just-bash" : "just-bash (network disabled)",
      metadata: {
        route: "just-bash",
        sawUntrusted: state.sawUntrusted,
        sawSecret: state.sawSecret,
        networkEnabled,
      },
    })
    return formatShellResult({
      ...result,
      route: "just-bash",
      networkEnabled,
    })
  },
})
