const SETTLE_MS = 100

const UNSEEN =
  'position:fixed;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap'

const SKIPPED = 'button, a, [role="button"], [aria-hidden="true"], [hidden]'

type Priority = 'polite' | 'assertive'

interface Regions {
  polite: HTMLElement
  assertive: HTMLElement
  owner: string | undefined
  pending: ReturnType<typeof setTimeout> | undefined
}

let current: Regions | undefined

function region(role: string, priority: Priority) {
  const element = document.createElement('div')
  element.setAttribute('role', role)
  element.setAttribute('aria-live', priority)
  element.setAttribute('aria-atomic', 'true')
  element.dataset['usherAnnouncer'] = priority
  element.style.cssText = UNSEEN
  document.body.append(element)

  return element
}

function regions(): Regions {
  if (current?.polite.isConnected && current.assertive.isConnected) {
    return current
  }

  current?.polite.remove()
  current?.assertive.remove()

  current = {
    polite: region('status', 'polite'),
    assertive: region('alert', 'assertive'),
    owner: undefined,
    pending: undefined,
  }

  return current
}

export function prepareAnnouncements() {
  regions()
}

function silence(found: Regions) {
  clearTimeout(found.pending)
  found.polite.replaceChildren()
  found.assertive.replaceChildren()
}

export function announce(
  owner: string,
  priority: 'polite' | 'assertive',
  text: string,
) {
  const found = regions()
  silence(found)
  found.owner = owner

  found.pending = setTimeout(
    () => found[priority].replaceChildren(text),
    SETTLE_MS,
  )
}

export function withdraw(owner: string) {
  if (current?.owner === owner) {
    silence(current)
    current.owner = undefined
  }
}

export function spoken(container: Element) {
  const unseen =
    container.closest('[aria-hidden="true"], [hidden]') !== null ||
    ('checkVisibility' in container && !container.checkVisibility())

  if (unseen) {
    return ''
  }

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const words: string[] = []

  while (walker.nextNode()) {
    const node = walker.currentNode

    if (node instanceof Text && !node.parentElement?.closest(SKIPPED)) {
      words.push(node.data)
    }
  }

  return words.join(' ').replaceAll(/\s+/g, ' ').trim()
}
