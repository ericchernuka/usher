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
