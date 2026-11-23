import * as valibot from 'valibot'
import type { Environment, VersionResponse } from './environment'
import type { CheckProblem } from './types'
import { parseBuildFacts, type BuildFacts } from './build-facts'
import { resolveVersionCheck, type VersionCheckOptions } from './options'
import { createListeners, type Readable } from './readable'
import { insideTab, type Tab } from './tab'
import { createVisibleTimer } from './visible-timer'

const MIN_FOCUS_CHECK_GAP_MS = 60_000
const FETCH_TIMEOUT_MS = 30_000

interface VersionCheckSettings {
  versionUrl: string
  pollInterval: number
  env: Environment
  clock: { observe(serverTime: number): void }
  onCheckProblem: VersionCheckOptions['onCheckProblem']
}

interface Watching {
  stopListening: Array<() => void>
  inFlight?: AbortController | undefined
}

interface Answer {
  res: VersionResponse
  facts: BuildFacts | CheckProblem
}

async function readFacts(
  res: VersionResponse,
  versionUrl: string,
): Promise<BuildFacts | CheckProblem> {
  if (!res.ok) {
    return { kind: 'http-error', versionUrl, status: res.status }
  }

  let body: unknown

  try {
    body = await res.json()
  } catch (error) {
    if (!(error instanceof Error && error.name === 'SyntaxError')) {
      throw error
    }

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

function returned(problem: CheckProblem) {
  if (problem.kind === 'http-error') {
    return `HTTP ${problem.status}`
  }

  if (problem.kind === 'not-json') {
    return `a body that is not JSON (${problem.contentType ?? 'no content type'})`
  }

  return `JSON that is not build facts (${problem.issues})`
}

class VersionCheck implements Readable<BuildFacts | undefined> {
  readonly #settings: VersionCheckSettings
  readonly #poll: ReturnType<typeof createVisibleTimer>
  readonly #listeners = createListeners({
    start: () => this.#start(),
    stop: () => this.#stop(),
  })

  #latest: BuildFacts | undefined
  #lastCheck: { monotonic: number; wall: number } | undefined
  #reported = false
  #watching: Watching | undefined

  constructor(settings: VersionCheckSettings) {
    this.#settings = settings
    this.#poll = createVisibleTimer(settings.env, () => void this.#check())
  }

  get = () => this.#latest

  subscribe = (listener: () => void) => this.#listeners.subscribe(listener)

  /**
   * Time since the last check started. Some browsers stop the monotonic clock
   * while the device sleeps, so the wall clock counts too; whichever says more
   * time has passed wins, and a wrong guess costs one extra request.
   */
  #sinceCheck = () => {
    const { env } = this.#settings

    return this.#lastCheck
      ? Math.max(
          env.monotonicNow() - this.#lastCheck.monotonic,
          env.wallNow() - this.#lastCheck.wall,
        )
      : Infinity
  }

  #checkUrl = () => {
    const { env, versionUrl } = this.#settings
    const url = new URL(versionUrl, env.baseUrl())
    url.searchParams.set('t', String(env.wallNow()))

    return url.href
  }

  #schedulePoll = () => {
    this.#poll.arm(() => this.#settings.pollInterval - this.#sinceCheck())
  }

  #recheck = () => {
    if (this.#sinceCheck() >= MIN_FOCUS_CHECK_GAP_MS) {
      void this.#check()
    }
  }

  #check = async () => {
    const { env } = this.#settings

    if (!this.#watching || !env.isVisible()) {
      return
    }

    this.#watching.inFlight?.abort()
    const controller = new AbortController()
    this.#watching.inFlight = controller
    this.#lastCheck = { monotonic: env.monotonicNow(), wall: env.wallNow() }
    this.#schedulePoll()

    const answer = await this.#request(controller)

    if (answer && !controller.signal.aborted) {
      this.#accept(answer)
    }
  }

  /** The answer to one request, or nothing when none arrived in time */
  #request = async (controller: AbortController) => {
    const { env, versionUrl } = this.#settings

    const cancelTimeout = env.startTimer(
      () => controller.abort(new DOMException('timed out', 'TimeoutError')),
      FETCH_TIMEOUT_MS,
    )

    try {
      const res = await env.fetch(this.#checkUrl(), {
        cache: 'no-store',
        signal: controller.signal,
      })

      return { res, facts: await readFacts(res, versionUrl) }
    } catch {
      return undefined
    } finally {
      cancelTimeout()

      if (this.#watching?.inFlight === controller) {
        this.#watching.inFlight = undefined
      }
    }
  }

  #accept = ({ res, facts }: Answer) => {
    if ('kind' in facts) {
      return this.#reportOnce(facts)
    }

    const serverTime = Date.parse(res.headers.get('date') ?? '')

    if (!Number.isNaN(serverTime)) {
      this.#settings.clock.observe(serverTime)
    }

    this.#reported = false
    this.#latest = facts
    this.#listeners.notify()
  }

  #reportOnce = (problem: CheckProblem) => {
    if (this.#reported) {
      return
    }

    this.#reported = true

    console.warn(
      `[usher] ${problem.versionUrl} should return build facts as JSON, but returned ${returned(problem)}. Updates cannot be detected until it does.`,
    )

    void this.#tellApp(problem)
  }

  #tellApp = async (problem: CheckProblem) => {
    try {
      await this.#settings.onCheckProblem?.(problem)
    } catch (error) {
      console.error('[usher] onCheckProblem threw', error)
    }
  }

  #start = () => {
    const { env } = this.#settings

    this.#watching = {
      stopListening: [
        env.onVisibilityChange(this.#recheck),
        env.onFocus(this.#recheck),
      ],
    }

    this.#schedulePoll()
    this.#recheck()
  }

  #stop = () => {
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

export function createVersionCheck(
  tab: Tab,
  options: VersionCheckOptions,
): Readable<BuildFacts | undefined> {
  const { versionUrl, pollInterval } = resolveVersionCheck(options)

  return new VersionCheck({
    ...insideTab(tab),
    versionUrl,
    pollInterval,
    onCheckProblem: options.onCheckProblem,
  })
}
