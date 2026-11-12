/** Run app code without letting it break the machine. */
export function isolate<A extends unknown[]>(
  label: string,
  fn: ((...args: A) => void) | undefined,
  ...args: A
) {
  try {
    fn?.(...args)
  } catch (error) {
    console.error(`[app-version] ${label} threw`, error)
  }
}

/** Base UI-style details object: a payload plus cancel() / isCanceled. */
export function withCancel<T extends object>(
  base: T,
): T & { cancel: () => void; readonly isCanceled: boolean } {
  let canceled = false

  return Object.defineProperties(
    Object.assign(base, {
      cancel: () => void (canceled = true),
      isCanceled: false,
    }),
    {
      cancel: { enumerable: false, writable: false, configurable: false },
      isCanceled: {
        get: () => canceled,
        enumerable: true,
        configurable: false,
      },
    },
  )
}
