const SETTLE_MS = 100

const UNSEEN =
  'position:fixed;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap'

const SKIPPED = 'button, a, [role="button"], [aria-hidden="true"], [hidden]'

const PRIORITIES = ['polite', 'assertive'] as const

interface Region {
  element: HTMLElement
  said: ReadonlyArray<string>
  pending: ReturnType<typeof setTimeout> | undefined
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
  element.setAttribute('aria-atomic', 'true')
  element.dataset['usherAnnouncer'] = priority
  element.style.cssText = UNSEEN
  doc.body.append(element)

  return { element, said: [], pending: undefined }
}

function announcerIn(doc: Document): Announcer {
  const found = announcers.get(doc)

  if (
    found?.polite.element.isConnected &&
    found.assertive.element.isConnected
  ) {
    return found
  }

  found?.polite.element.remove()
  found?.assertive.element.remove()

  const announcer: Announcer = {
    claims: found?.claims ?? new Map(),
    polite: region(doc, 'polite'),
    assertive: region(doc, 'assertive'),
  }

  announcers.set(doc, announcer)

  return announcer
}

function settle(announcer: Announcer) {
  for (const priority of PRIORITIES) {
    const target = announcer[priority]

    const wanted = Array.from(
      new Set(
        Array.from(announcer.claims.values()).flatMap(claimed =>
          claimed.priority === priority ? [claimed.text] : [],
        ),
      ),
    )

    if (wanted.length > 0 && wanted.every(text => target.said.includes(text))) {
      continue
    }

    clearTimeout(target.pending)
    target.element.replaceChildren()
    target.said = wanted

    target.pending =
      wanted.length > 0
        ? setTimeout(
            () => target.element.replaceChildren(wanted.join(' ')),
            SETTLE_MS,
          )
        : undefined
  }
}

export function prepareAnnouncements(doc: Document) {
  announcerIn(doc)
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

const rendered = (element: Element) =>
  !('checkVisibility' in element) || element.checkVisibility()

export function spoken(container: Element) {
  if (container.closest('[aria-hidden="true"], [hidden]')) {
    return ''
  }

  const walker = container.ownerDocument.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
  )

  const words: string[] = []

  while (walker.nextNode()) {
    const parent = walker.currentNode.parentElement

    if (parent && !parent.closest(SKIPPED) && rendered(parent)) {
      words.push(walker.currentNode.nodeValue ?? '')
    }
  }

  return words.join(' ').replaceAll(/\s+/g, ' ').trim()
}
