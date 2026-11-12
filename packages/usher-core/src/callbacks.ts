export function isolate<A extends unknown[]>(
  label: string,
  fn: ((...args: A) => void) | undefined,
  ...args: A
) {
  try {
    fn?.(...args)
  } catch (error) {
    console.error(`[usher] ${label} threw`, error)
  }
}
