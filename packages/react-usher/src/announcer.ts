const SETTLE_MS = 100

const UNSEEN =
  'position:fixed;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap'

const SKIPPED = 'button, a, [role="button"], [aria-hidden="true"]'

const PRIORITIES = ['polite', 'assertive'] as const

interface Region {
  element: HTMLElement
  shown: Map<string, HTMLElement>
  pending: Map<string, ReturnType<typeof setTimeout>>
}

interface Announcer {
  claims: Map<Element, { priority: 'polite' | 'assertive'; text: string }>
  polite: Region
  assertive: Region
}

const announcers = new WeakMap<Document, Announcer>()

function region(doc: Document, priority: 'polite' | 'assertive'): Region {
  const element = doc.createElement('div')
  element.setAttribute('role', priority === 'polite' ? 'status' : 'alert')
  element.setAttribute('aria-live', priority)
  element.setAttribute('aria-atomic', 'false')
  element.setAttribute('aria-relevant', 'additions text')
  element.dataset['usherAnnouncer'] = priority
  element.style.cssText = UNSEEN
  doc.body.append(element)

  return { element, shown: new Map(), pending: new Map() }
}

function retire(found: Region) {
  found.pending.forEach(timer => clearTimeout(timer))
  found.element.remove()
}

function announcerIn(doc: Document): Announcer {
  const found = announcers.get(doc)

  if (
    found?.polite.element.isConnected &&
    found.assertive.element.isConnected
  ) {
    return found
  }

  if (found) {
    retire(found.polite)
    retire(found.assertive)
  }

  const announcer: Announcer = {
    claims: found?.claims ?? new Map(),
    polite: region(doc, 'polite'),
    assertive: region(doc, 'assertive'),
  }

  announcers.set(doc, announcer)

  return announcer
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
  const child = target.element.ownerDocument.createElement('div')
  child.textContent = text
  target.pending.delete(text)
  target.shown.set(text, child)
  target.element.append(child)
}

function settle(announcer: Announcer) {
  for (const priority of PRIORITIES) {
    const target = announcer[priority]

    const wanted = new Set(
      Array.from(announcer.claims.values()).flatMap(claimed =>
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

export function prepareAnnouncements(doc: Document) {
  settle(announcerIn(doc))
}

export function claim(
  container: Element,
  priority: 'polite' | 'assertive',
  text: string,
) {
  const announcer = announcerIn(container.ownerDocument)
  announcer.claims.set(container, { priority, text })
  settle(announcer)
}

export function release(container: Element) {
  const announcer = announcers.get(container.ownerDocument)

  if (announcer?.claims.delete(container)) {
    settle(announcer)
  }
}

function seen(text: Node) {
  const parent = text.parentElement

  if (!parent || parent.closest(SKIPPED)) {
    return false
  }

  const range = text.ownerDocument?.createRange()
  range?.selectNodeContents(text)

  return (
    range?.getClientRects().length !== 0 &&
    getComputedStyle(parent).visibility === 'visible'
  )
}

export function spoken(container: Element) {
  const walker = container.ownerDocument.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
  )

  const words: string[] = []

  while (walker.nextNode()) {
    if (seen(walker.currentNode)) {
      words.push(walker.currentNode.nodeValue ?? '')
    }
  }

  return words.join(' ').replaceAll(/\s+/g, ' ').trim()
}
