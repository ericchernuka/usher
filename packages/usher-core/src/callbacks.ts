export function isolate<Args extends unknown[]>(
  label: string,
  fn: ((...args: Args) => void) | undefined,
  ...args: Args
) {
  try {
    fn?.(...args)
  } catch (error) {
    console.error(`[usher] ${label} threw`, error)
  }
}
