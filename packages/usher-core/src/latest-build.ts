import * as valibot from 'valibot'
import type { Environment } from './environment'
import { parseBuildFacts, type BuildFacts } from './build-facts'
import { createVisibleTimer } from './visible-timer'

const MIN_FOCUS_CHECK_GAP_MS = 60_000
const FETCH_TIMEOUT_MS = 30_000

export interface LatestBuildOptions {
  versionUrl: string
  pollInterval: number
  env: Environment
  clock: { observe(serverTime: number): void }
}

interface Watching {
  onChange: () => void
  stopListening: Array<() => void>
  inFlight?: AbortController | undefined
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

  const parsed = parseBuildFacts(body)

  return parsed.success
    ? parsed.output
    : {
        problem: `JSON that is not build facts (${valibot.summarize(parsed.issues)})`,
      }
}

export class LatestBuild {
  readonly options: LatestBuildOptions
  readonly poll: ReturnType<typeof createVisibleTimer>
  latest: BuildFacts | undefined
  lastCheck: { monotonic: number; wall: number } | undefined
  warned = false
  watching: Watching | undefined

  constructor(options: LatestBuildOptions) {
    this.options = options
    this.poll = createVisibleTimer(options.env, this.onPoll)
  }

  get = () => this.latest

  /**
   * Time since the last check started. Some browsers stop the monotonic clock
   * while the device sleeps, so the wall clock counts too; whichever says more
   * time has passed wins, and a wrong guess costs one extra request.
   */
  sinceCheck = () => {
    const { env } = this.options

    return this.lastCheck
      ? Math.max(
          env.monotonicNow() - this.lastCheck.monotonic,
          env.wallNow() - this.lastCheck.wall,
        )
      : Infinity
  }

  checkUrl = () => {
    const { env, versionUrl } = this.options
    const url = new URL(versionUrl, env.baseUrl())
    url.searchParams.set('t', String(env.wallNow()))

    return url.href
  }

  schedulePoll = () => {
    if (this.watching) {
      this.poll.arm(this.options.pollInterval - this.sinceCheck())
    }
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

  resume = () => {
    this.schedulePoll()
    this.recheck()
  }

  check = async () => {
    const { env } = this.options

    if (!this.watching || !env.isVisible()) {
      return
    }

    this.watching.inFlight?.abort()
    const controller = new AbortController()
    this.watching.inFlight = controller
    this.lastCheck = { monotonic: env.monotonicNow(), wall: env.wallNow() }
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

    this.warned = false
    this.latest = facts
    this.watching?.onChange()
  }

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
        env.onVisibilityChange(this.resume),
        env.onFocus(this.recheck),
      ],
    }

    this.resume()
  }

  stop = () => {
    if (!this.watching) {
      return
    }

    const { stopListening, inFlight } = this.watching
    this.watching = undefined
    this.poll.cancel()

    if (inFlight) {
      inFlight.abort()
      this.lastCheck = undefined
    }

    stopListening.forEach(stop => stop())
  }
}
