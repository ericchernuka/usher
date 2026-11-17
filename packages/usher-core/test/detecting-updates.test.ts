import { http, HttpResponse } from 'msw/http'
import { vi } from 'vitest'
import { VERSION_URL } from './mocks/handlers'
import { server } from './mocks/node'
import {
  serveBuild,
  serveError,
  serveHang,
  serveNetworkError,
  serveRaw,
} from './mocks/overrides'
import {
  HOUR,
  MINUTE,
  SECOND,
  describe,
  expect,
  newer,
  older,
  test,
} from './fixtures'

describe('checking for a new build', () => {
  test('given a subscriber, then the check is a cache-busting, uncacheable GET', async ({
    app,
    tab,
    requests,
  }) => {
    const fetchCall = vi.spyOn(globalThis, 'fetch')
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()

    const [request] = requests
    const url = new URL(request?.url ?? '')
    expect(request?.method).toBe('GET')
    expect(url.origin + url.pathname).toBe(VERSION_URL)
    expect(Number(url.searchParams.get('t'))).toBe(tab.now())
    expect(fetchCall).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cache: 'no-store' }),
    )
    expect(store.getState().attention).toBe('none')
  })

  test('given no check has landed yet, then the state is none:unknown', ({
    app,
  }) => {
    expect(app.create().getState()).toEqual({
      attention: 'none',
      reason: 'unknown',
    })
  })

  test('given a same-day deploy, when the check lands, then subscribers hear of a passive update', async ({
    app,
    tab,
  }) => {
    server.use(serveBuild(newer))
    const store = app.create()
    const listener = vi.fn<() => void>()
    app.subscribe(store, listener)
    await tab.waitForResponse()

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      latest: { version: 'bbb' },
    })
    expect(listener).toHaveBeenCalled()
  })

  test('given a version URL that already has a query, then the check keeps it and adds the cache buster', async ({
    app,
    tab,
    requests,
  }) => {
    const store = app.create({ versionUrl: `${VERSION_URL}?channel=beta` })
    app.subscribe(store)
    await tab.waitForResponse()

    const url = new URL(requests[0]?.url ?? '')
    expect(url.searchParams.get('channel')).toBe('beta')
    expect(Number(url.searchParams.get('t'))).toBe(tab.now())
    expect(store.getState().reason).toBe('caught-up')
  })

  test('given a relative version URL, then the check resolves it against the page', async ({
    app,
    tab,
    requests,
  }) => {
    app.subscribe(app.create({ versionUrl: './version.json' }))
    await tab.waitForResponse()

    const url = new URL(requests[0]?.url ?? '')
    expect(url.origin + url.pathname).toBe(VERSION_URL)
  })

  test('given the server answers with something that is not a build, then it is ignored', async ({
    app,
    tab,
  }) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    server.use(serveRaw({}))
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()

    expect(store.getState()).toEqual({ attention: 'none', reason: 'unknown' })
  })

  test('given version.json carries fields the tab does not know, then the snapshot keeps only build facts', async ({
    app,
    tab,
  }) => {
    server.use(serveRaw({ ...newer, deployedBy: 'ci' }))
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()

    expect(store.getState()).toEqual({
      attention: 'passive',
      reason: 'outdated',
      latest: newer,
    })
  })

  test('given a deploy is in progress (5xx), then the tab keeps what it knew and the next check picks the build up', async ({
    app,
    tab,
  }) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    server.use(serveBuild(newer, { once: true }))
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()
    server.use(serveError(503))
    await app.poll()

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      latest: { version: 'bbb' },
    })

    server.use(serveBuild({ ...newer, version: 'ccc' }))
    await app.poll()

    expect(store.getState()).toMatchObject({ latest: { version: 'ccc' } })
  })
})

describe('slow and hung checks', () => {
  test('given a check is slow, when the tab remounts and a newer check lands first, then the slow answer never overwrites it', async ({
    app,
    tab,
  }) => {
    const late = Promise.withResolvers<void>()
    server.use(
      http.get(
        VERSION_URL,
        async () => {
          await late.promise

          return HttpResponse.json(older)
        },
        { once: true },
      ),
      serveBuild(newer),
    )
    const store = app.create()
    const first = store.subscribe(() => {})
    await tab.flush()
    first()
    app.subscribe(store)
    await tab.waitForResponse()

    late.resolve()
    await tab.waitForResponse()

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      latest: { version: 'bbb' },
    })
  })

  test('given a check hangs, when 30s pass, then the tab gives up and the next check lands', async ({
    app,
    tab,
  }) => {
    server.use(serveHang({ once: true }), serveBuild(newer))
    const store = app.create()
    app.subscribe(store)
    await tab.flush()
    await expect(tab.waitForResponse()).rejects.toThrow(
      /Timed out waiting for 1 response/,
    )

    await tab.runFor(30_000)

    expect(store.getState().attention).toBe('none')
    await app.poll()
    expect(store.getState()).toMatchObject({
      attention: 'passive',
      latest: { version: 'bbb' },
    })
  })
})

describe('polling schedule', () => {
  test('given a focus-triggered check, then the next poll counts from it', async ({
    app,
    tab,
    requests,
  }) => {
    app.subscribe(app.create({ pollInterval: 5 * MINUTE }))
    await tab.waitForResponse()
    await tab.runFor(4 * MINUTE + 50_000)
    tab.focus()
    await tab.waitForResponse()
    const afterFocus = requests.length

    await tab.runFor(4 * MINUTE)
    expect(requests).toHaveLength(afterFocus)

    await tab.runFor(MINUTE)
    expect(requests).toHaveLength(afterFocus + 1)
  })

  test('given focus or visibility returns within a minute of a check, then the tab does not check again', async ({
    app,
    tab,
    requests,
  }) => {
    app.subscribe(app.create())
    await tab.waitForResponse()
    await tab.runFor(MINUTE - SECOND)

    tab.focus()
    tab.setVisibility('visible')
    await tab.waitForResponse()
    expect(requests).toHaveLength(1)

    await tab.runFor(SECOND)
    tab.focus()
    await tab.waitForResponse()
    expect(requests).toHaveLength(2)
  })

  test('given the last subscriber leaves and one returns within a minute of a check, then the tab does not check again and keeps its poll schedule', async ({
    app,
    tab,
    requests,
  }) => {
    const store = app.create({ pollInterval: 5 * MINUTE })
    const stop = app.subscribe(store)
    await tab.waitForResponse()

    stop()
    app.subscribe(store)
    await tab.waitForResponse()
    expect(requests).toHaveLength(1)

    await tab.runFor(5 * MINUTE)
    expect(requests).toHaveLength(2)
  })

  test('given the device slept and its monotonic clock stood still, when focus returns, then the tab checks', async ({
    app,
    tab,
    requests,
  }) => {
    app.subscribe(app.create())
    await tab.waitForResponse()

    tab.setSystemTime(tab.now() + 2 * HOUR)
    tab.focus()
    await tab.waitForResponse()

    expect(requests).toHaveLength(2)
  })

  test("given the user's clock jumps back a day, then polling carries on", async ({
    app,
    tab,
    requests,
  }) => {
    app.subscribe(app.create())
    await tab.waitForResponse()
    const before = requests.length

    tab.setSystemTime(tab.now() - 24 * HOUR)
    await tab.runFor(10 * MINUTE)

    expect(requests.length).toBeGreaterThan(before)
  })
})

describe('hidden tabs', () => {
  test('given the tab is hidden for an hour, then it keeps no timer and fetches nothing, and checks as soon as it returns', async ({
    app,
    tab,
    requests,
  }) => {
    app.subscribe(app.create({ pollInterval: 5 * MINUTE }))
    await tab.waitForResponse()
    await tab.runFor(5 * MINUTE)
    expect(requests).toHaveLength(2)

    tab.setVisibility('hidden')
    expect(tab.pendingTimers()).toBe(0)
    await tab.runFor(HOUR)
    expect(requests).toHaveLength(2)

    tab.setVisibility('visible')
    await tab.waitForResponse()
    expect(requests).toHaveLength(3)
    await tab.runFor(5 * MINUTE)
    expect(requests).toHaveLength(4)
  })

  test("given a tab that starts hidden, then it doesn't fetch until it's visible", async ({
    app,
    tab,
    requests,
  }) => {
    tab.setVisibilitySilently('hidden')
    app.subscribe(app.create())
    await tab.waitForResponse()

    expect(requests).toHaveLength(0)
    expect(tab.pendingTimers()).toBe(0)

    tab.setVisibility('visible')
    await tab.waitForResponse()

    expect(requests).toHaveLength(1)
  })
})

describe('build age and the server clock', () => {
  test("given the page's clock runs 30 h fast, then build age follows the server's Date header", async ({
    app,
    tab,
  }) => {
    tab.setSystemTime('2026-11-12T22:00:00Z')
    server.use(serveBuild(newer, { date: new Date('2026-11-11T16:00:00Z') }))
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'outdated',
    })
  })

  test('given a later response has no Date header, then the tab keeps the last clock correction', async ({
    app,
    tab,
  }) => {
    server.use(serveBuild(newer, { skewMs: 11 * HOUR }))
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()
    expect(store.getState().attention).toBe('prompt')

    server.use(serveBuild(newer, { date: null }))
    await tab.runFor(5 * MINUTE)

    expect(store.getState().attention).toBe('prompt')
  })
})

describe('a version file that is missing or misrouted', () => {
  test('given the host answers with its HTML fallback, then the tab warns once across several checks', async ({
    app,
    tab,
  }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    server.use(
      http.get(VERSION_URL, () => HttpResponse.html('<!doctype html>')),
    )
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()
    await app.poll()
    await app.poll()

    expect(store.getState()).toEqual({ attention: 'none', reason: 'unknown' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /https:\/\/app\.test\/version\.json .* not JSON \(text\/html/,
      ),
    )
  })

  test('given a 404 and then JSON that is not build facts, then only the first is reported', async ({
    app,
    tab,
  }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    server.use(serveError(404, { once: true }), serveRaw({}))
    app.subscribe(app.create())
    await tab.waitForResponse()
    await app.poll()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 404'))
  })

  test('given the file recovers and then breaks again, then the second outage is reported too', async ({
    app,
    tab,
  }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    server.use(serveError(404, { once: true }))
    app.subscribe(app.create())
    await tab.waitForResponse()
    await app.poll()

    server.use(serveError(503))
    await app.poll()
    await app.poll()

    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('HTTP 503'))
  })

  test('given the version request fails outright, then the tab warns once and names the URL', async ({
    app,
    tab,
  }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    server.use(serveNetworkError())
    app.subscribe(app.create())
    await tab.waitForResponse()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[usher\] https:\/\/app\.test\/version\.json .*request failed/,
      ),
    )
  })

  test('given the version request fails on every poll, then the tab warns once', async ({
    app,
    tab,
  }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    server.use(serveNetworkError())
    app.subscribe(app.create())
    await tab.waitForResponse()
    await app.poll()
    await app.poll()

    expect(warn).toHaveBeenCalledTimes(1)
  })

  test('given a check is superseded by a newer one, then the aborted check does not warn', async ({
    app,
    tab,
  }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    server.use(serveHang({ once: true }), serveBuild(newer))
    const store = app.create({ pollInterval: 10 * SECOND })
    app.subscribe(store)
    await tab.flush()
    await tab.runFor(10 * SECOND)
    await tab.waitForResponse()

    expect(store.getState().attention).toBe('passive')
    expect(warn).not.toHaveBeenCalled()
  })

  test('given a check is aborted as the tab becomes hidden, then the tab does not warn', async ({
    app,
    tab,
  }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      tab.setVisibility('hidden')

      throw new DOMException('aborted', 'AbortError')
    })
    app.subscribe(app.create())
    await tab.flush()

    expect(warn).not.toHaveBeenCalled()
  })
})
