import { listen, type BrowserEnvironment } from './browser'
import { isBuildFacts, type BuildFacts } from './types'

/** Focus and visibility recheck at most this often. */
const MIN_FOCUS_CHECK_GAP_MS = 60_000
const FETCH_TIMEOUT_MS = 30_000
const MAX_TIMER_MS = 2 ** 31 - 1

export interface LatestBuildOptions {
  versionUrl: string
  pollInterval: number
  browser: BrowserEnvironment
  /** Told the server time of each response that carries a Date header. */
  clock: { observe(serverTime: number): void }
}

interface Watching {
  onChange: () => void
  stopListening: Array<() => void>
  inFlight?: AbortController | undefined
  poll?: ReturnType<typeof setTimeout> | undefined
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

const monotonicNow = () => performance.now()

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

  visible = () => this.options.browser.document.visibilityState === 'visible'

  sinceCheck = () => monotonicNow() - this.lastCheck

  checkUrl = () => {
    const url = new URL(
      this.options.versionUrl,
      this.options.browser.document.baseURI,
    )

    url.searchParams.set('t', String(Date.now()))

    return url.href
  }

  schedulePoll = () => {
    if (!this.watching) {
      return
    }

    clearTimeout(this.watching.poll)
    this.watching.poll = undefined

    if (!this.visible()) {
      return
    }

    const due = this.lastCheck + this.options.pollInterval - monotonicNow()
    const delay = Math.min(Math.max(0, due), MAX_TIMER_MS)
    this.watching.poll = setTimeout(this.onPoll, delay)
  }

  onPoll = () => {
    if (this.sinceCheck() >= this.options.pollInterval) {
      void this.check()
    } else {
      this.schedulePoll()
    }
  }

  recheck = () => {
    if (this.visible() && this.sinceCheck() >= MIN_FOCUS_CHECK_GAP_MS) {
      void this.check()
    }
  }

  check = async () => {
    if (!this.watching || !this.visible()) {
      return
    }

    this.watching.inFlight?.abort()
    const controller = new AbortController()
    this.watching.inFlight = controller
    this.lastCheck = monotonicNow()
    this.schedulePoll()

    const timeout = setTimeout(
      () => controller.abort(new DOMException('timed out', 'TimeoutError')),
      FETCH_TIMEOUT_MS,
    )

    try {
      const res = await this.options.browser.fetch(this.checkUrl(), {
        cache: 'no-store',
        signal: controller.signal,
      })

      const facts = await readFacts(res)

      if (!controller.signal.aborted) {
        this.accept(res, facts)
      }
    } catch {
    } finally {
      clearTimeout(timeout)

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
      `[app-version] ${this.options.versionUrl} should return build facts as JSON, but returned ${problem}. Updates cannot be detected until it does.`,
    )
  }

  start = (onChange: () => void) => {
    const { document, window } = this.options.browser

    this.watching = {
      onChange,
      stopListening: [
        listen(document, 'visibilitychange', () => {
          this.schedulePoll()
          this.recheck()
        }),
        listen(window, 'focus', this.recheck),
      ],
    }

    void this.check()
  }

  stop = () => {
    if (!this.watching) {
      return
    }

    const { stopListening, inFlight, poll } = this.watching
    this.watching = undefined
    clearTimeout(poll)
    inFlight?.abort()
    stopListening.forEach(stop => stop())
  }
}

export function createLatestBuild(options: LatestBuildOptions) {
  return new LatestBuild(options)
}
