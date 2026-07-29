import { SessionRunner, type Runner, type SessionRunnerConfig } from '@claude-worker/core'
import type { SessionInfo } from '@claude-worker/protocol'

/** In-memory session table. Terminal sessions stay listed until removed or the process exits. */
export class SessionRegistry {
  #sessions = new Map<string, Runner>()

  create(config: SessionRunnerConfig): Runner {
    const runner = new SessionRunner(config)
    this.#sessions.set(runner.id, runner)
    void runner.start()
    return runner
  }

  get(id: string): Runner | undefined {
    return this.#sessions.get(id)
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((r) => r.info())
  }

  remove(id: string): boolean {
    const runner = this.#sessions.get(id)
    if (!runner) return false
    runner.close('server')
    return this.#sessions.delete(id)
  }

  closeAll(): void {
    for (const runner of this.#sessions.values()) runner.close('server')
  }
}
