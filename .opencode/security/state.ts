import path from "node:path"

export type SessionMode = "clean" | "secret-only" | "tainted" | "secret-tainted"

const GUARDED_AGENT = "guarded-builder"

type PendingCall = {
  tool: string
  secretInput: boolean
  modeBefore: SessionMode
}

type SessionState = {
  agent?: string
  sawUntrusted: boolean
  sawSecret: boolean
  secretLiterals: Set<string>
  taintedStrings: Set<string>
  taintedFiles: Set<string>
  pendingCalls: Map<string, PendingCall>
  justBashRuntime?: {
    fs: unknown
    bash: unknown
    networkEnabled: boolean
    worktree: string
    scratchRoot: string
  }
}

type SecurityState = {
  sessions: Map<string, SessionState>
}

const GLOBAL_KEY = "__MYSHELL_TAINT_SECURITY_STATE__"
const MAX_TRACKED_STRING = 8 * 1024

function getGlobalState(): SecurityState {
  const globalScope = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: SecurityState
  }
  if (!globalScope[GLOBAL_KEY]) {
    globalScope[GLOBAL_KEY] = {
      sessions: new Map(),
    }
  }
  return globalScope[GLOBAL_KEY]!
}

export function getSessionState(sessionID: string): SessionState {
  const store = getGlobalState()
  let session = store.sessions.get(sessionID)
  if (!session) {
    session = {
      agent: undefined,
      sawUntrusted: false,
      sawSecret: false,
      secretLiterals: new Set(),
      taintedStrings: new Set(),
      taintedFiles: new Set(),
      pendingCalls: new Map(),
    }
    store.sessions.set(sessionID, session)
  }
  return session
}

export function getSessionMode(sessionID: string): SessionMode {
  const state = getSessionState(sessionID)
  if (state.sawUntrusted && state.sawSecret) {
    return "secret-tainted"
  }
  if (state.sawUntrusted) {
    return "tainted"
  }
  if (state.sawSecret) {
    return "secret-only"
  }
  return "clean"
}

export function setSessionAgent(sessionID: string, agent?: string): void {
  const normalized = typeof agent === "string" ? agent.trim() : ""
  getSessionState(sessionID).agent = normalized || undefined
}

export function getSessionAgent(sessionID: string): string | undefined {
  return getSessionState(sessionID).agent
}

export function isGuardedSession(sessionID: string): boolean {
  return getSessionAgent(sessionID) === GUARDED_AGENT
}

export function markSessionUntrusted(sessionID: string): boolean {
  const state = getSessionState(sessionID)
  if (state.sawUntrusted) {
    return false
  }
  state.sawUntrusted = true
  return true
}

export function markSessionSecret(sessionID: string): boolean {
  const state = getSessionState(sessionID)
  if (state.sawSecret) {
    return false
  }
  state.sawSecret = true
  return true
}

export function rememberPendingCall(
  sessionID: string,
  callID: string,
  tool: string,
  secretInput: boolean,
  modeBefore: SessionMode,
): void {
  getSessionState(sessionID).pendingCalls.set(callID, { tool, secretInput, modeBefore })
}

export function takePendingCall(sessionID: string, callID: string): PendingCall | undefined {
  const state = getSessionState(sessionID)
  const pending = state.pendingCalls.get(callID)
  if (pending) {
    state.pendingCalls.delete(callID)
  }
  return pending
}

export function hasPendingWebCall(sessionID: string): boolean {
  const state = getSessionState(sessionID)
  for (const pending of state.pendingCalls.values()) {
    if (pending.tool === "webfetch" || pending.tool === "websearch") {
      return true
    }
  }
  return false
}

export function clearPendingWebCalls(sessionID: string): void {
  const state = getSessionState(sessionID)
  for (const [callID, pending] of state.pendingCalls.entries()) {
    if (pending.tool === "webfetch" || pending.tool === "websearch") {
      state.pendingCalls.delete(callID)
    }
  }
}

export function parseSecretsFromEnv(text: string): string[] {
  const values = new Set<string>()
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()
    line = line.replace(/^\d+:\s*/, "")
    if (!line || line.startsWith("#")) {
      continue
    }
    if (line.startsWith("<") || line.startsWith("(")) {
      continue
    }
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line
    const equalsIndex = withoutExport.indexOf("=")
    if (equalsIndex <= 0) {
      continue
    }
    const key = withoutExport.slice(0, equalsIndex).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue
    }
    let value = withoutExport.slice(equalsIndex + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value && value.length <= MAX_TRACKED_STRING) {
      values.add(value)
    }
  }
  return [...values]
}

export function rememberSecretLiterals(sessionID: string, values: Iterable<string>): void {
  const state = getSessionState(sessionID)
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > MAX_TRACKED_STRING) {
      continue
    }
    state.secretLiterals.add(trimmed)
    state.taintedStrings.add(trimmed)
  }
}

export function rememberTaintedString(sessionID: string, value: string): void {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_TRACKED_STRING) {
    return
  }
  getSessionState(sessionID).taintedStrings.add(trimmed)
}

export function rememberTaintedFile(sessionID: string, filePath: string, worktree?: string): void {
  const state = getSessionState(sessionID)
  for (const alias of buildPathAliases(filePath, worktree)) {
    state.taintedFiles.add(alias)
  }
}

export function stringContainsSecret(sessionID: string, value: string, worktree?: string): boolean {
  if (!value) {
    return false
  }
  const state = getSessionState(sessionID)
  const views = deriveSecretComparableViews(value)
  for (const view of views) {
    for (const secret of state.secretLiterals) {
      if (secret && view.includes(secret)) {
        return true
      }
    }
    for (const tainted of state.taintedStrings) {
      if (tainted && view.includes(tainted)) {
        return true
      }
    }
  }

  for (const taintedPath of state.taintedFiles) {
    if (!taintedPath) {
      continue
    }
    for (const view of views) {
      if (view.includes(taintedPath)) {
        return true
      }
    }
  }

  if (worktree) {
    for (const view of views) {
      const normalized = normalizeMaybePath(view, worktree)
      if (normalized && state.taintedFiles.has(normalized)) {
        return true
      }
    }
  }

  return false
}

function deriveSecretComparableViews(value: string): Set<string> {
  const views = new Set<string>()
  views.add(value)

  const decodedURL = safeDecodeURIComponent(value)
  if (decodedURL && decodedURL !== value) {
    views.add(decodedURL)
  }

  for (const token of extractBase64Tokens(value)) {
    const decoded = decodeBase64Token(token)
    if (decoded) {
      views.add(decoded)
      const decodedURLToken = safeDecodeURIComponent(decoded)
      if (decodedURLToken && decodedURLToken !== decoded) {
        views.add(decodedURLToken)
      }
    }
  }

  return views
}

function safeDecodeURIComponent(value: string): string | undefined {
  if (!value.includes("%") && !value.includes("+")) {
    return undefined
  }
  try {
    return decodeURIComponent(value.replace(/\+/g, "%20"))
  } catch {
    return undefined
  }
}

function extractBase64Tokens(value: string): Set<string> {
  const tokens = new Set<string>()
  for (const match of value.matchAll(/[A-Za-z0-9+/_=-]{12,}/g)) {
    if (match[0]) {
      tokens.add(match[0])
    }
  }
  return tokens
}

function decodeBase64Token(token: string): string | undefined {
  const normalized = token.replace(/-/g, "+").replace(/_/g, "/")
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) {
    return undefined
  }
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
  try {
    const decoded = Buffer.from(padded, "base64").toString("utf8")
    if (!decoded || decoded.length > MAX_TRACKED_STRING) {
      return undefined
    }
    if (!/[\x09\x0A\x0D\x20-\x7E]/.test(decoded)) {
      return undefined
    }
    return decoded
  } catch {
    return undefined
  }
}

export function argsContainSecret(sessionID: string, value: unknown, worktree?: string): boolean {
  const strings = collectStrings(value)
  for (const item of strings) {
    if (stringContainsSecret(sessionID, item, worktree)) {
      return true
    }
  }
  return false
}

export function isEnvPath(filePath: string): boolean {
  const name = path.basename(filePath)
  if (name === ".env.example") {
    return false
  }
  return name === ".env" || name.startsWith(".env.")
}

export function commandMayReadSecrets(command: string): boolean {
  const withoutComments = command.replace(/#.*/g, "")
  const tokens = withoutComments.split(/[\s;"'`|&<>()$*?[\]{}]/)
  for (const rawToken of tokens) {
    const token = rawToken.replace(/^["']+|["']+$/g, "")
    if (!token) continue
    const basename = token.split(/[\\/]/).pop() || token
    if (basename === ".env") {
      return true
    }
    if (basename.startsWith(".env.") && basename !== ".env.example") {
      return true
    }
  }
  return false
}

export function isLikelyNetworkCommand(command: string): boolean {
  return [
    /(^|[;&|]\s*)curl(\s|$)/,
    /(^|[;&|]\s*)wget(\s|$)/,
    /(^|[;&|]\s*)nc(\s|$)/,
    /(^|[;&|]\s*)ncat(\s|$)/,
    /(^|[;&|]\s*)netcat(\s|$)/,
    /(^|[;&|]\s*)telnet(\s|$)/,
    /(^|[;&|]\s*)ftp(\s|$)/,
    /(^|[;&|]\s*)scp(\s|$)/,
    /(^|[;&|]\s*)sftp(\s|$)/,
    /(^|[;&|]\s*)ssh(\s|$)/,
    /(^|[;&|]\s*)git\s+push(\s|$)/,
  ].some((pattern) => pattern.test(command))
}

export function rememberToolOutputTaint(sessionID: string, secretInput: boolean, output: string): void {
  if (secretInput) {
    rememberTaintedString(sessionID, output)
  }
}

export function extractWritablePathsFromTool(tool: string, args: unknown): string[] {
  if (!args || typeof args !== "object") {
    return []
  }
  const input = args as Record<string, unknown>
  const direct = [] as string[]
  if (typeof input.filePath === "string") {
    direct.push(input.filePath)
  }
  if (typeof input.path === "string") {
    direct.push(input.path)
  }
  if (tool === "bash" || tool === "native-bash") {
    const command = typeof input.command === "string" ? input.command : ""
    const matches = command.matchAll(/(?:^|\s)(?:>|>>|tee\s+)([^\s]+)/g)
    for (const match of matches) {
      if (match[1]) {
        direct.push(match[1])
      }
    }
  }
  return direct
}

function collectStrings(value: unknown, result = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    result.add(value)
    return result
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, result)
    }
    return result
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectStrings(nested, result)
    }
  }
  return result
}

function buildPathAliases(filePath: string, worktree?: string): Set<string> {
  const aliases = new Set<string>()
  const normalized = normalizeMaybePath(filePath, worktree)
  if (normalized) {
    aliases.add(normalized)
    aliases.add(normalized.replace(/\\/g, "/"))
    if (worktree && normalized.startsWith(worktree)) {
      const relative = path.relative(worktree, normalized)
      aliases.add(relative)
      aliases.add(`/workspace/${relative.replace(/\\/g, "/")}`)
    }
  }
  aliases.add(filePath)
  return aliases
}

function normalizeMaybePath(value: string, worktree?: string): string | undefined {
  if (!value) {
    return undefined
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return undefined
  }
  if (value.startsWith("/workspace/") && worktree) {
    return path.normalize(path.join(worktree, value.slice("/workspace/".length)))
  }
  if (path.isAbsolute(value)) {
    return path.normalize(value)
  }
  if (worktree && !value.includes("\n")) {
    return path.normalize(path.join(worktree, value))
  }
  return undefined
}
