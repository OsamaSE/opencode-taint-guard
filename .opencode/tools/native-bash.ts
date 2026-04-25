import { tool } from "@opencode-ai/plugin"
import { formatShellResult, runNativeShell } from "../security/native-shell"
import { argsContainSecret, commandMayReadSecrets, getSessionState, isGuardedSession, isLikelyNetworkCommand } from "../security/state"

export default tool({
  description:
    "Explicit host-shell override. Use this only when you need native bash after the session has become untrusted. Approval is required every time.",
  args: {
    command: tool.schema.string().describe("Host shell command to execute"),
  },
  async execute(args, context) {
    const state = getSessionState(context.sessionID)
    const guarded = context.agent === "guarded-builder" || isGuardedSession(context.sessionID)

    await context.ask({
      permission: "native-bash",
      patterns: ["native-bash"],
      always: [],
      metadata: {
        command: args.command,
        sawUntrusted: state.sawUntrusted,
        sawSecret: state.sawSecret,
      },
    })

    if (
      guarded &&
      state.sawUntrusted &&
      state.sawSecret &&
      isLikelyNetworkCommand(args.command) &&
      argsContainSecret(context.sessionID, args.command, context.worktree)
    ) {
      throw new Error("Blocked native-bash: secret-tainted data cannot be sent to network commands in a secret+tainted session.")
    }

    if (guarded && state.sawUntrusted && commandMayReadSecrets(args.command)) {
      throw new Error("Blocked native-bash: reading secret files is not allowed in tainted sessions.")
    }

    const result = await runNativeShell({
      command: args.command,
      cwd: context.directory,
      signal: context.abort,
    })

    context.metadata({
      title: "native bash override",
      metadata: {
        route: "native-override",
        sawUntrusted: state.sawUntrusted,
        sawSecret: state.sawSecret,
        networkEnabled: true,
      },
    })

    return formatShellResult({
      ...result,
      route: "native-bash-override",
      networkEnabled: true,
    })
  },
})
