import { HOUR, MINUTE, SECOND, describe, expect, test } from './fixtures'
import type { StoreOptions } from './fake-host'

describe('validating options', () => {
  test.for<{ name: string; options: StoreOptions; message: RegExp }>([
    {
      name: 'a negative promptAfter',
      options: { promptAfter: -1 },
      message: /promptAfter must be a finite, non-negative number/,
    },
    {
      name: 'an infinite urgentAfter',
      options: { urgentAfter: Infinity },
      message: /urgentAfter must be a finite, non-negative number/,
    },
    {
      name: 'a promptSnooze that is not a number',
      options: { promptSnooze: Number.NaN },
      message: /promptSnooze must be a finite, non-negative number/,
    },
    {
      name: 'a string duration from untyped code',
      options: JSON.parse('{"pollInterval":"5m"}'),
      message: /pollInterval must be a finite, non-negative number/,
    },
    {
      name: 'a pollInterval under 10 seconds',
      options: { pollInterval: 10 * SECOND - 1 },
      message: /pollInterval must be at least 10000 ms/,
    },
    {
      name: 'urgentAfter equal to promptAfter',
      options: { promptAfter: 12 * HOUR, urgentAfter: 12 * HOUR },
      message: /urgentAfter must be later than promptAfter/,
    },
    {
      name: 'a zero promptSnooze',
      options: { promptSnooze: 0 },
      message: /promptSnooze must be positive/,
    },
    {
      name: 'promptSnooze with the prompt level off',
      options: { promptAfter: false, promptSnooze: HOUR },
      message: /promptSnooze has no effect when promptAfter is false/,
    },
  ])(
    'given $name, then creating the store fails naming the option',
    ({ options, message }, { app }) => {
      expect(() => app.create(options)).toThrow(message)
    },
  )

  test('given the smallest allowed values, then the store is created', ({
    app,
  }) => {
    expect(() =>
      app.create({
        pollInterval: 10 * SECOND,
        promptAfter: 0,
        urgentAfter: MINUTE,
        promptSnooze: 1,
      }),
    ).not.toThrow()
    expect(() =>
      app.create({ promptAfter: false, urgentAfter: false }),
    ).not.toThrow()
  })
})
