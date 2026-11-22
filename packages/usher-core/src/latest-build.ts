import * as valibot from 'valibot'
import type { Environment } from './environment'
import type { CheckProblem } from './types'
import { parseBuildFacts, type BuildFacts } from './build-facts'
import { createVisibleTimer } from './visible-timer'

const MIN_FOCUS_CHECK_GAP_MS = 60_000
const FETCH_TIMEOUT_MS = 30_000

export interface LatestBuildOptions {
  versionUrl: string
  pollInterval: number
  env: Environment
  clock: { observe(serverTime: number): void }
  onProblem: (problem: CheckProblem) => void
}

interface Watching {
  onChange: () => void
  stopListening: Array<() => void>
  inFlight?: AbortController | undefined
}

async function readFacts(
  res: Response,
  versionUrl: string,
): Promise<BuildFacts | CheckProblem> {
  if (!res.ok) {
    return { kind: 'http-error', versionUrl, status: res.status }
  }

  let body: unknown

  try {
    body = await res.json()
  } catch {
    const contentType = res.headers.get('content-type')

    return { kind: 'not-json', versionUrl, contentType }
  }

  const parsed = parseBuildFacts(body)

  return parsed.success
    ? parsed.output
    : {
        kind: 'not-build-facts',
        versionUrl,
        issues: valibot.summarize(parsed.issues),
      }
}

export class LatestBuild {
  readonly #options: LatestBuildOptions
  readonly #poll: ReturnType<typeof createVisibleTimer>
  #latest: BuildFacts | undefined
  #lastCheck: { monotonic: number; wall: number } | undefined
  #reported = false
  #watching: Watching | undefined

  constructor(options: LatestBuildOptions) {
    this.#options = options
    this.#poll = createVisibleTimer(options.env, () => void this.#check())
  }

  get = () => this.#latest

  /**
   * Time since the last check started. Some browsers stop the monotonic clock
   * while the device sleeps, so the wall clock counts too; whichever says more
   * time has passed wins, and a wrong guess costs one extra request.
   */
  #sinceCheck = () => {
    const { env } = this.#options

    return this.#lastCheck
      ? Math.max(
          env.monotonicNow() - this.#lastCheck.monotonic,
          env.wallNow() - this.#lastCheck.wall,
        )
      : Infinity
  }

  #checkUrl = () => {
    const { env, versionUrl } = this.#options
    const url = new URL(versionUrl, env.baseUrl())
    url.searchParams.set('t', String(env.wallNow()))

    return url.href
  }

  #schedulePoll = () => {
    this.#poll.arm(() => this.#options.pollInterval - this.#sinceCheck())
  }

  #recheck = () => {
    if (this.#sinceCheck() >= MIN_FOCUS_CHECK_GAP_MS) {
      void this.#check()
    }
  }

  #check = async () => {
    const { env } = this.#options

    if (!this.#watching || !env.isVisible()) {
      return
    }

    this.#watching.inFlight?.abort()
    const controller = new AbortController()
    this.#watching.inFlight = controller
    this.#lastCheck = { monotonic: env.monotonicNow(), wall: env.wallNow() }
    this.#schedulePoll()

    const cancelTimeout = env.startTimer(
      () => controller.abort(new DOMException('timed out', 'TimeoutError')),
      FETCH_TIMEOUT_MS,
    )

    try {
      const res = await env.fetch(this.#checkUrl(), {
        cache: 'no-store',
        signal: controller.signal,
      })

      const facts = await readFacts(res, this.#options.versionUrl)

      if (!controller.signal.aborted) {
        this.#accept(res, facts)
      }
    } catch {
    } finally {
      cancelTimeout()

      if (this.#watching?.inFlight === controller) {
        this.#watching.inFlight = undefined
      }
    }
  }

  #accept = (res: Response, facts: BuildFacts | CheckProblem) => {
    if ('kind' in facts) {
      return this.#reportOnce(facts)
    }

    const serverTime = Date.parse(res.headers.get('date') ?? '')

    if (!Number.isNaN(serverTime)) {
      this.#options.clock.observe(serverTime)
    }

    this.#reported = false
    this.#latest = facts
    this.#watching?.onChange()
  }

  #reportOnce = (problem: CheckProblem) => {
    if (!this.#reported) {
      this.#reported = true
      this.#options.onProblem(problem)
    }
  }

  start = (onChange: () => void) => {
    const { env } = this.#options

    this.#watching = {
      onChange,
      stopListening: [
        env.onVisibilityChange(this.#recheck),
        env.onFocus(this.#recheck),
      ],
    }

    this.#schedulePoll()
    this.#recheck()
  }

  stop = () => {
    if (!this.#watching) {
      return
    }

    const { stopListening, inFlight } = this.#watching
    this.#watching = undefined
    this.#poll.cancel()

    if (inFlight) {
      inFlight.abort()
      this.#lastCheck = undefined
    }

    stopListening.forEach(stop => stop())
  }
}
