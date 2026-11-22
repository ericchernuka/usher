import * as valibot from 'valibot'
import { parseBuildFacts } from './build-facts'
import type { AppUpdatesOptions } from './types'

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

const Options = valibot.pipe(
  valibot.object({
    running: valibot.pipe(
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
    ),
    promptAfter: level('promptAfter', DEFAULT_PROMPT_AFTER),
    urgentAfter: level('urgentAfter', DEFAULT_URGENT_AFTER),
    promptSnooze: valibot.optional(
      valibot.pipe(
        duration('promptSnooze'),
        valibot.gtValue(0, 'promptSnooze must be positive'),
      ),
    ),
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
    storageKey: valibot.optional(
      valibot.string('storageKey must be a string'),
      'usher',
    ),
    reload: callback('reload'),
    onCheckProblem: callback('onCheckProblem'),
  }),
  valibot.partialCheck(
    [['promptAfter'], ['urgentAfter']],
    ({ promptAfter, urgentAfter }) =>
      promptAfter === undefined ||
      urgentAfter === undefined ||
      urgentAfter > promptAfter,
    issue =>
      `urgentAfter must be later than promptAfter, got urgentAfter ${String(issue.input.urgentAfter)} ms and promptAfter ${String(issue.input.promptAfter)} ms`,
  ),
  valibot.partialCheck(
    [['promptAfter'], ['promptSnooze']],
    ({ promptAfter, promptSnooze }) =>
      promptSnooze === undefined || promptAfter !== undefined,
    'promptSnooze has no effect when promptAfter is false',
  ),
)

/**
 * Options with every default applied and every rule checked. `reload` and
 * `onCheckProblem` are checked here, but the store reads them from the options
 * it was given, where they keep their types.
 */
export type ResolvedOptions = valibot.InferOutput<typeof Options>

export type Thresholds = Pick<
  ResolvedOptions,
  'promptAfter' | 'urgentAfter' | 'promptSnooze'
>

/** Throws an error that names the option when one is invalid. */
export function resolveOptions(options: AppUpdatesOptions): ResolvedOptions {
  const parsed = valibot.safeParse(Options, options, { abortEarly: true })

  if (!parsed.success) {
    throw new Error(`[usher] ${parsed.issues[0].message}`)
  }

  return parsed.output
}
