const SETTLE_MS = 100

const UNSEEN =
  'position:fixed;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap'

const PRIORITIES = ['polite', 'assertive'] as const

interface Region {
  element: HTMLElement
  shown: Map<string, HTMLElement>
  pending: Map<string, ReturnType<typeof setTimeout>>
}

const claims = new Map<
  symbol,
  { priority: 'polite' | 'assertive'; text: string }
>()

const regions = new Map<'polite' | 'assertive', Region>()

function regionFor(priority: 'polite' | 'assertive'): Region {
  const found = regions.get(priority)

  if (found?.element.isConnected) {
    return found
  }

  found?.pending.forEach(timer => clearTimeout(timer))

  const element = document.createElement('div')
  element.setAttribute('role', priority === 'polite' ? 'status' : 'alert')
  element.setAttribute('aria-live', priority)
  element.setAttribute('aria-atomic', 'false')
  element.setAttribute('aria-relevant', 'additions text')
  element.dataset['usherAnnouncer'] = priority
  element.style.cssText = UNSEEN
  document.body.append(element)

  const made: Region = { element, shown: new Map(), pending: new Map() }
  regions.set(priority, made)

  return made
}

function withdraw(target: Region, wanted: ReadonlySet<string>) {
  for (const [text, child] of target.shown) {
    if (!wanted.has(text)) {
      child.remove()
      target.shown.delete(text)
    }
  }

  for (const [text, timer] of target.pending) {
    if (!wanted.has(text)) {
      clearTimeout(timer)
      target.pending.delete(text)
    }
  }
}

function say(target: Region, text: string) {
  const child = document.createElement('div')
  child.textContent = text
  target.pending.delete(text)
  target.shown.set(text, child)
  target.element.append(child)
}

export function settle() {
  for (const priority of PRIORITIES) {
    const target = regionFor(priority)

    const wanted = new Set(
      Array.from(claims.values()).flatMap(claimed =>
        claimed.priority === priority ? [claimed.text] : [],
      ),
    )

    withdraw(target, wanted)

    for (const text of wanted) {
      if (!target.shown.has(text) && !target.pending.has(text)) {
        target.pending.set(
          text,
          setTimeout(() => say(target, text), SETTLE_MS),
        )
      }
    }
  }
}

export function claim(
  owner: symbol,
  priority: 'polite' | 'assertive',
  text: string,
) {
  claims.set(owner, { priority, text })
  settle()
}

export function release(owner: symbol) {
  if (claims.delete(owner)) {
    settle()
  }
}
