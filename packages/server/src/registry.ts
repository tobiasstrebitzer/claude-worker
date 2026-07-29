import { SessionRunner, type Runner, type SessionRunnerConfig } from '@claude-worker/core'
import type { SessionInfo } from '@claude-worker/protocol'

/** In-memory session table. Terminal sessions stay listed until removed or the process exits. */
export class SessionRegistry {
  #sessions = new Map<string, Runner>()

  create(config: SessionRunnerConfig): Runner {
    return this.adopt(new SessionRunner(config))
  }

  /** Build and list a Claude-engine runner without starting it, so watchers can
   * subscribe first. Call `start()` once they have. */
  prepare(config: SessionRunnerConfig): Runner {
    return this.register(new SessionRunner(config))
  }

  /** Register an already-built runner (a non-Claude engine) and start it. */
  adopt(runner: Runner): Runner {
    this.register(runner)
    void runner.start()
    return runner
  }

  /** List a runner without starting it — for a rehydrated session, whose watchers
   * must be subscribed before it comes back up. */
  register(runner: Runner): Runner {
    this.#sessions.set(runner.id, runner)
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

  /** Drop a runner WITHOUT closing it: the session isn't ending, it parked and
   * lives on in its snapshot. Closing here would tell every client it was over. */
  evict(id: string): boolean {
    return this.#sessions.delete(id)
  }

  closeAll(): void {
    for (const runner of this.#sessions.values()) runner.close('server')
  }
}
