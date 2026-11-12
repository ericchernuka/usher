import type { AppUpdatesOptions } from './types'

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

const DEFAULT_PROMPT_AFTER = 12 * HOUR
const DEFAULT_URGENT_AFTER = 24 * HOUR
const DEFAULT_POLL_INTERVAL = 5 * MINUTE
const MIN_POLL_INTERVAL = 10 * SECOND

/** Validated durations in milliseconds. `undefined` means the level is off, or for the snooze, "until urgent". */
export interface Thresholds {
  promptAfter: number | undefined
  urgentAfter: number | undefined
  promptSnooze: number | undefined
}

function fail(message: string): never {
  throw new Error(`[app-version] ${message}`)
}

function duration(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    fail(
      `${name} must be a finite, non-negative number of milliseconds, got ${String(value)}`,
    )
  }

  return value
}

function level(name: string, value: number | false | undefined) {
  return value === false || value === undefined
    ? undefined
    : duration(name, value)
}

function snooze(value: number | undefined, promptAfter: number | undefined) {
  if (value === undefined) {
    return undefined
  }

  if (duration('promptSnooze', value) === 0) {
    fail('promptSnooze must be positive')
  }

  if (promptAfter === undefined) {
    fail('promptSnooze has no effect when promptAfter is false')
  }

  return value
}

export function resolveThresholds(
  options: Pick<
    AppUpdatesOptions,
    'promptAfter' | 'urgentAfter' | 'promptSnooze'
  > = {},
): Thresholds {
  const promptAfter = level(
    'promptAfter',
    options.promptAfter ?? DEFAULT_PROMPT_AFTER,
  )

  const urgentAfter = level(
    'urgentAfter',
    options.urgentAfter ?? DEFAULT_URGENT_AFTER,
  )

  if (
    promptAfter !== undefined &&
    urgentAfter !== undefined &&
    urgentAfter <= promptAfter
  ) {
    fail('urgentAfter must be later than promptAfter')
  }

  return {
    promptAfter,
    urgentAfter,
    promptSnooze: snooze(options.promptSnooze, promptAfter),
  }
}

export function resolvePollInterval(value = DEFAULT_POLL_INTERVAL): number {
  if (duration('pollInterval', value) < MIN_POLL_INTERVAL) {
    fail(`pollInterval must be at least ${MIN_POLL_INTERVAL} ms (10 seconds)`)
  }

  return value
}
