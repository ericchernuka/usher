import * as valibot from 'valibot'
import { parseBuildFacts } from './build-facts'
import type { BuildFacts } from './build-facts'
import type { CheckProblem } from './types'

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

const DEFAULT_PROMPT_AFTER = 12 * HOUR
const DEFAULT_URGENT_AFTER = 24 * HOUR
const DEFAULT_POLL_INTERVAL = 5 * MINUTE
const MIN_POLL_INTERVAL = 10 * SECOND

const notDuration = (name: string) => (issue: valibot.BaseIssue<unknown>) =>
  `${name} must be a finite, non-negative number of milliseconds, got ${String(issue.input)}`

function duration(name: string) {
  const message = notDuration(name)

  return valibot.pipe(
    valibot.number(message),
    valibot.finite(message),
    valibot.minValue(0, message),
  )
}

function level(name: string, fallback: number) {
  const off = valibot.pipe(
    valibot.literal(false),
    valibot.transform(() => undefined),
  )

  return valibot.nullish(
    valibot.union([off, duration(name)], notDuration(name)),
    fallback,
  )
}

function callback(name: string) {
  return valibot.optional(
    valibot.function(
      issue => `${name} must be a function, got ${String(issue.input)}`,
    ),
  )
}

const versionUrlMessage = (issue: valibot.BaseIssue<unknown>) =>
  `versionUrl must be the URL of version.json, got ${String(issue.input)}`

function output<Schema extends valibot.GenericSchema>(
  parsed: valibot.SafeParseResult<Schema>,
): valibot.InferOutput<Schema> {
  if (!parsed.success) {
    throw new Error(`[usher] ${parsed.issues[0].message}`)
  }

  return parsed.output
}

export interface VersionCheckOptions {
  /** URL of the serving deployment's version.json */
  versionUrl: string
  /**
   * Milliseconds between version checks in a visible tab, at least
   * 10 seconds and 5 minutes by default
   */
  pollInterval?: number
  /**
   * Handler for a version check that cannot get build facts, called once
   * per outage so the app can report a deployment whose tabs cannot detect
   * updates, and never while the browser is offline or for timeouts
   */
  onCheckProblem?: (problem: CheckProblem) => void | Promise<void>
}

const VersionCheck = valibot.object({
  versionUrl: valibot.pipe(
    valibot.string(versionUrlMessage),
    valibot.check(
      value => URL.canParse(value, 'https://app.invalid'),
      versionUrlMessage,
    ),
  ),
  pollInterval: valibot.optional(
    valibot.pipe(
      duration('pollInterval'),
      valibot.minValue(
        MIN_POLL_INTERVAL,
        `pollInterval must be at least ${MIN_POLL_INTERVAL} ms (10 seconds)`,
      ),
    ),
    DEFAULT_POLL_INTERVAL,
  ),
  onCheckProblem: callback('onCheckProblem'),
})

export const resolveVersionCheck = (options: VersionCheckOptions) =>
  output(valibot.safeParse(VersionCheck, options, { abortEarly: true }))

export interface EscalationOptions {
  /**
   * Milliseconds a tab may stay outdated before prompt attention, 12 hours
   * by default, or `false` for no prompt level
   */
  promptAfter?: number | false
  /**
   * Milliseconds a tab may stay outdated before urgent attention, later
   * than `promptAfter` and 24 hours by default, or `false` for no urgent
   * level from escalation
   */
  urgentAfter?: number | false
}

const Escalation = valibot.pipe(
  valibot.object({
    promptAfter: level('promptAfter', DEFAULT_PROMPT_AFTER),
    urgentAfter: level('urgentAfter', DEFAULT_URGENT_AFTER),
  }),
  valibot.check(
    ({ promptAfter, urgentAfter }) =>
      promptAfter === undefined ||
      urgentAfter === undefined ||
      urgentAfter > promptAfter,
    issue =>
      `urgentAfter must be later than promptAfter, got urgentAfter ${String(issue.input.urgentAfter)} ms and promptAfter ${String(issue.input.promptAfter)} ms`,
  ),
)

export const resolveEscalation = (options: EscalationOptions) =>
  output(valibot.safeParse(Escalation, options, { abortEarly: true }))

export interface PromptDismissalOptions {
  /**
   * Milliseconds a prompt dismissal quiets prompt attention, by default
   * until urgent attention starts
   */
  promptSnooze?: number
  /**
   * Prefix for the localStorage keys, `usher` by default, set per app
   * when apps share an origin
   */
  storageKey?: string
}

const PromptDismissal = valibot.object({
  promptSnooze: valibot.optional(
    valibot.pipe(
      duration('promptSnooze'),
      valibot.gtValue(0, 'promptSnooze must be positive'),
    ),
  ),
  storageKey: valibot.optional(
    valibot.string('storageKey must be a string'),
    'usher',
  ),
})

export const resolvePromptDismissal = (options: PromptDismissalOptions) =>
  output(valibot.safeParse(PromptDismissal, options, { abortEarly: true }))

export interface RefreshOptions {
  /**
   * Document load a refresh performs, `location.reload()` by default, that
   * returns or resolves `false` when it knows the load did not happen
   */
  reload?: () => void | boolean | Promise<void | boolean>
}

const Refresh = valibot.object({ reload: callback('reload') })

export const resolveRefresh = (options: RefreshOptions) =>
  output(valibot.safeParse(Refresh, options, { abortEarly: true }))

const Running = valibot.pipe(
  valibot.unknown(),
  valibot.rawTransform(({ dataset, addIssue, NEVER }) => {
    const parsed = parseBuildFacts(dataset.value)

    if (parsed.success) {
      return parsed.output
    }

    addIssue({
      message: `running must be the running build's build facts: ${valibot.summarize(parsed.issues)}`,
    })

    return NEVER
  }),
)

export const resolveRunning = (running: BuildFacts) =>
  output(valibot.safeParse(Running, running, { abortEarly: true }))
