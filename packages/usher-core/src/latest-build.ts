import type { Environment } from './environment'
import { isBuildFacts, type BuildFacts } from './types'

/** Focus and visibility recheck at most this often. */
const MIN_FOCUS_CHECK_GAP_MS = 60_000
const FETCH_TIMEOUT_MS = 30_000
const MAX_TIMER_MS = 2 ** 31 - 1

export interface LatestBuildOptions {
  versionUrl: string
  pollInterval: number
  env: Environment
  /** Told the server time of each response that carries a Date header. */
  clock: { observe(serverTime: number): void }
}

interface Watching {
  onChange: () => void
  stopListening: Array<() => void>
  inFlight?: AbortController | undefined
  cancelPoll?: (() => void) | undefined
}

interface Rejected {
  problem: string
}

async function readFacts(res: Response): Promise<BuildFacts | Rejected> {
  if (!res.ok) {
    return { problem: `HTTP ${res.status}` }
  }

  let body: unknown

  try {
    body = await res.json()
  } catch {
    const type = res.headers.get('content-type') ?? 'no content type'

    return { problem: `a body that is not JSON (${type})` }
  }

  return isBuildFacts(body) ? body : { problem: 'JSON that is not build facts' }
}

/**
 * Observes the serving deployment: polls `version.json` while the tab is visible,
 * rechecks on focus and visibility, and keeps the last valid build facts it saw.
 */
class LatestBuild {
  readonly options: LatestBuildOptions
  latest: BuildFacts | undefined
  lastCheck = -Infinity
  warned = false
  watching: Watching | undefined

  constructor(options: LatestBuildOptions) {
    this.options = options
  }

  get = () => this.latest

  sinceCheck = () => this.options.env.monotonicNow() - this.lastCheck

  checkUrl = () => {
    const { env, versionUrl } = this.options
    const url = new URL(versionUrl, env.baseUrl())
    url.searchParams.set('t', String(env.wallNow()))

    return url.href
  }

  schedulePoll = () => {
    if (!this.watching) {
      return
    }

    const { env, pollInterval } = this.options
    this.watching.cancelPoll?.()
    this.watching.cancelPoll = undefined

    if (!env.isVisible()) {
      return
    }

    const due = this.lastCheck + pollInterval - env.monotonicNow()
    const delay = Math.min(Math.max(0, due), MAX_TIMER_MS)
    this.watching.cancelPoll = env.startTimer(this.onPoll, delay)
  }

  onPoll = () => {
    if (this.sinceCheck() >= this.options.pollInterval) {
      void this.check()
    } else {
      this.schedulePoll()
    }
  }

  recheck = () => {
    if (
      this.options.env.isVisible() &&
      this.sinceCheck() >= MIN_FOCUS_CHECK_GAP_MS
    ) {
      void this.check()
    }
  }

  check = async () => {
    const { env } = this.options

    if (!this.watching || !env.isVisible()) {
      return
    }

    this.watching.inFlight?.abort()
    const controller = new AbortController()
    this.watching.inFlight = controller
    this.lastCheck = env.monotonicNow()
    this.schedulePoll()

    const cancelTimeout = env.startTimer(
      () => controller.abort(new DOMException('timed out', 'TimeoutError')),
      FETCH_TIMEOUT_MS,
    )

    try {
      const res = await env.fetch(this.checkUrl(), {
        cache: 'no-store',
        signal: controller.signal,
      })

      const facts = await readFacts(res)

      if (!controller.signal.aborted) {
        this.accept(res, facts)
      }
    } catch {
    } finally {
      cancelTimeout()

      if (this.watching?.inFlight === controller) {
        this.watching.inFlight = undefined
      }
    }
  }

  accept = (res: Response, facts: BuildFacts | Rejected) => {
    if ('problem' in facts) {
      return this.warnOnce(facts.problem)
    }

    const serverTime = Date.parse(res.headers.get('date') ?? '')

    if (!Number.isNaN(serverTime)) {
      this.options.clock.observe(serverTime)
    }

    this.latest = facts
    this.watching?.onChange()
  }

  /** A missing or misrouted version.json would otherwise fail silently forever. */
  warnOnce = (problem: string) => {
    if (this.warned) {
      return
    }

    this.warned = true
    console.warn(
      `[usher] ${this.options.versionUrl} should return build facts as JSON, but returned ${problem}. Updates cannot be detected until it does.`,
    )
  }

  start = (onChange: () => void) => {
    const { env } = this.options

    this.watching = {
      onChange,
      stopListening: [
        env.onVisibilityChange(() => {
          this.schedulePoll()
          this.recheck()
        }),
        env.onFocus(this.recheck),
      ],
    }

    void this.check()
  }

  stop = () => {
    if (!this.watching) {
      return
    }

    const { stopListening, inFlight, cancelPoll } = this.watching
    this.watching = undefined
    cancelPoll?.()
    inFlight?.abort()
    stopListening.forEach(stop => stop())
  }
}

export function createLatestBuild(options: LatestBuildOptions) {
  return new LatestBuild(options)
}
