/** Client-side preferences persisted in localStorage (see SettingsView). */

import type { ModelOption, PermissionMode } from '@claude-worker/protocol'
import { PERMISSION_MODES } from '@claude-worker/ui'

/** Pre-session model choices: aliases the CLI resolves to current model ids, mirroring
 * its supportedModels shape (a 'default' sentinel row first). Live sessions get the
 * CLI's own list via the capabilities event; forms and settings use this static one. */
export const MODEL_OPTIONS: ModelOption[] = [
  { value: 'default', displayName: 'Default (recommended)', description: "The CLI's configured default model" },
  { value: 'fable', displayName: 'Fable', description: 'Latest Fable — most intelligent model tier' },
  { value: 'opus', displayName: 'Opus', description: 'Latest Opus — most capable Opus-class model' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Latest Sonnet — balanced capability and speed' },
  { value: 'haiku', displayName: 'Haiku', description: 'Latest Haiku — fastest and most economical' },
]

/** Which creation form a default applies to: interactive sessions or queue jobs. */
export type DefaultsKind = 'session' | 'job'

const MODEL_KEYS: Record<DefaultsKind, string> = {
  session: 'claude-worker.default-session-model',
  job: 'claude-worker.default-job-model',
}

/** Default model pre-filled in the new-session / schedule-job forms. '' = CLI default. */
export function getDefaultModel(kind: DefaultsKind): string {
  return localStorage.getItem(MODEL_KEYS[kind]) ?? ''
}

export function setDefaultModel(kind: DefaultsKind, model: string): void {
  const trimmed = model.trim()
  if (trimmed) localStorage.setItem(MODEL_KEYS[kind], trimmed)
  else localStorage.removeItem(MODEL_KEYS[kind])
}

const PERMISSION_MODE_KEYS: Record<DefaultsKind, string> = {
  session: 'claude-worker.default-session-permission-mode',
  job: 'claude-worker.default-job-permission-mode',
}

/** Built-in fallbacks: interactive sessions ask by default; unattended jobs
 * auto-approve edits so they don't stall on every file write. */
const PERMISSION_MODE_FALLBACKS: Record<DefaultsKind, PermissionMode> = {
  session: 'default',
  job: 'acceptEdits',
}

/** Default permission mode pre-selected in the new-session / schedule-job forms. */
export function getDefaultPermissionMode(kind: DefaultsKind): PermissionMode {
  const stored = localStorage.getItem(PERMISSION_MODE_KEYS[kind])
  const valid = PERMISSION_MODES.some((m) => m.value === stored)
  return valid ? (stored as PermissionMode) : PERMISSION_MODE_FALLBACKS[kind]
}

export function setDefaultPermissionMode(kind: DefaultsKind, mode: PermissionMode): void {
  localStorage.setItem(PERMISSION_MODE_KEYS[kind], mode)
}
