import type { Plugin } from "@opencode-ai/plugin"
import {
  argsContainSecret,
  commandTouchesEnv,
  clearPendingWebCalls,
  extractWritablePathsFromTool,
  getSessionMode,
  getSessionState,
  hasPendingWebCall,
  isEnvPath,
  isLikelyNetworkCommand,
  markSessionSecret,
  markSessionUntrusted,
  parseSecretsFromEnv,
  rememberPendingCall,
  rememberSecretLiterals,
  rememberTaintedFile,
  rememberToolOutputTaint,
  takePendingCall,
  type SessionMode,
} from "../security/state"

const SANDBOX_TITLE_SUFFIX = " [sandboxed]"
const SANDBOX_TITLE_PATTERN = /\[sandboxed\]/i

export const TaintSecurity: Plugin = async ({ client }) => {
  async function showModeToast(sessionID: string) {
    const mode = getSessionMode(sessionID)
    try {
      await client.tui.showToast({
        body: {
          variant: mode === "secret-tainted" ? "warning" : "info",
          message: `Security mode: ${mode}`,
        },
      })
    } catch {
      // Ignore when there is no interactive TUI client.
    }
  }

  async function showSandboxToast() {
    try {
      await client.tui.showToast({
        body: {
          title: "Sandbox enabled",
          variant: "warning",
          message: "This session is now sandboxed. Shell commands run in just-bash.",
        },
      })
    } catch {
      // Ignore when there is no interactive TUI client.
    }
  }

  async function ensureSandboxTagInTitle(sessionID: string) {
    try {
      const session = await client.session.get({
        path: { id: sessionID },
      })
      if (!session.data) {
        return
      }
      const currentTitle = String(session.data.title ?? "")
      if (!currentTitle.trim() || SANDBOX_TITLE_PATTERN.test(currentTitle)) {
        return
      }

      await client.session.update({
        path: { id: sessionID },
        body: {
          title: `${currentTitle}${SANDBOX_TITLE_SUFFIX}`,
        },
      })
    } catch {
      // Ignore title update failures to avoid interrupting tool execution.
    }
  }

  return {
    "tool.execute.before": async (input, output) => {
      const modeBefore = getSessionMode(input.sessionID)
      const state = getSessionState(input.sessionID)
      const secretInput = argsContainSecret(input.sessionID, output.args, state.justBashRuntime?.worktree)
      if (shouldTrackPendingCall(input.tool, output.args)) {
        rememberPendingCall(input.sessionID, input.callID, input.tool, secretInput, modeBefore)
      }

      if (input.tool === "bash" && hasPendingWebCall(input.sessionID)) {
        throw new Error("Blocked bash: wait for webfetch/websearch to complete before running shell commands.")
      }

      if ((input.tool === "webfetch" || input.tool === "websearch") && secretInput) {
        throw new Error(`Blocked ${input.tool}: secret-derived data cannot be sent to web tools.`)
      }
    },

    "tool.execute.after": async (input, output) => {
      const pending = takePendingCall(input.sessionID, input.callID)
      const beforeMode = pending?.modeBefore ?? getSessionMode(input.sessionID)

      if (input.tool === "webfetch" || input.tool === "websearch") {
        markSessionUntrusted(input.sessionID)
        clearPendingWebCalls(input.sessionID)
      }

      const envPath = readToolPath(input.tool, input.args)
      if (envPath && isEnvPath(envPath)) {
        markSessionSecret(input.sessionID)
        const parsed = parseSecretsFromEnv(output.output)
        rememberSecretLiterals(input.sessionID, parsed)
        rememberToolOutputTaint(input.sessionID, true, output.output)
      }

      const command = shellCommand(input.tool, input.args)
      if (command && commandTouchesEnv(command)) {
        markSessionSecret(input.sessionID)
        const parsed = parseSecretsFromEnv(output.output)
        rememberSecretLiterals(input.sessionID, parsed)
        rememberToolOutputTaint(input.sessionID, true, output.output)
      }

      if (pending?.secretInput) {
        rememberToolOutputTaint(input.sessionID, true, output.output)
        for (const outputPath of extractWritablePathsFromTool(input.tool, input.args)) {
          rememberTaintedFile(input.sessionID, outputPath, stateWorktree(input.sessionID))
        }
      }

      const afterMode = getSessionMode(input.sessionID)
      if (beforeMode !== afterMode) {
        const enteredSandbox = !isSandboxedMode(beforeMode) && isSandboxedMode(afterMode)
        if (enteredSandbox) {
          await showSandboxToast()
        } else {
          await showModeToast(input.sessionID)
        }
        if (isSandboxedMode(afterMode)) {
          await ensureSandboxTagInTitle(input.sessionID)
        }
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) {
        return
      }
      output.system.push(buildModeBanner(input.sessionID))
    },
  }
}

function shouldTrackPendingCall(tool: string, args: any): boolean {
  if (tool === "webfetch") {
    const url = typeof args?.url === "string" ? args.url.trim() : ""
    return /^https?:\/\//i.test(url)
  }
  if (tool === "websearch") {
    const query = typeof args?.query === "string" ? args.query.trim() : ""
    return query.length > 0
  }
  return true
}

function isSandboxedMode(mode: SessionMode): boolean {
  return mode === "tainted" || mode === "secret-tainted"
}

function buildModeBanner(sessionID: string): string {
  const mode = getSessionMode(sessionID)
  if (mode === "clean") {
    return "Security mode: clean. `bash` uses the host shell. `webfetch` and `websearch` are enabled."
  }
  if (mode === "secret-only") {
    return "Security mode: secret-only. Raw secret material has been read in this session. `bash` still uses the host shell until untrusted web data is read."
  }
  if (mode === "tainted") {
    return "Security mode: tainted. This session has read untrusted web data. `bash` routes to just-bash. `native-bash` is disabled in guarded mode."
  }
  return "Security mode: secret-tainted. This session has both secrets and untrusted web data. `bash` routes to just-bash with network disabled. `native-bash` is disabled in guarded mode. `webfetch` and `websearch` stay enabled, but they block secret-tainted arguments."
}

function readToolPath(tool: string, args: any): string | undefined {
  if (tool !== "read") {
    return undefined
  }
  return typeof args?.filePath === "string" ? args.filePath : undefined
}

function shellCommand(tool: string, args: any): string | undefined {
  if (tool !== "bash" && tool !== "native-bash") {
    return undefined
  }
  const command = typeof args?.command === "string" ? args.command : undefined
  if (!command) {
    return undefined
  }
  if (tool === "native-bash" && isLikelyNetworkCommand(command)) {
    return command
  }
  return command
}

function stateWorktree(sessionID: string): string | undefined {
  return getSessionState(sessionID).justBashRuntime?.worktree
}
