import {
  createContext,
  useContext,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ComponentProps,
  type CSSProperties,
  type RefObject,
  type ReactNode,
} from 'react'
import {
  createUpdateNotice,
  type Readable,
  type Refresh,
  type RefreshBlocker,
  type UpdateNotice as Notice,
  type UpdateNoticeOptions,
  type AppUpdates,
  type UpdateState,
} from '@rndsqr/usher-core'

function useReadable<Value>(readable: Readable<Value>): Value {
  return useSyncExternalStore(readable.subscribe, readable.get, readable.get)
}

/** Read the update state, deferred so a change never blocks input */
export function useUpdateState(state: Readable<UpdateState>): UpdateState {
  return useDeferredValue(useReadable(state))
}

/** Read whether a refresh is in flight, without starting version checks */
export function useRefreshing(refresh: Readable<boolean>): boolean {
  return useReadable(refresh)
}

/**
 * Block refreshes while mounted, with a boolean or a function that may be
 * written inline because the latest one is called
 */
export function useRefreshBlocker(
  refresh: Pick<Refresh, 'addBlocker'>,
  shouldBlock: boolean | RefreshBlocker,
): void {
  const latest = useRef(shouldBlock)

  useEffect(() => {
    latest.current = shouldBlock
  }, [shouldBlock])

  const registered = shouldBlock !== false

  useEffect(() => {
    if (!registered) {
      return undefined
    }

    return refresh.addBlocker(() => {
      const current = latest.current

      return current === true || (current !== false && current())
    })
  }, [refresh, registered])
}

/** Read the notice to show, for a component that renders its own markup */
export function useUpdateNotice(
  updates: AppUpdates,
  options: UpdateNoticeOptions = {},
): Notice | undefined {
  const { minAttention } = options

  const notice = useMemo(
    () => createUpdateNotice(updates, { minAttention }),
    [updates, minAttention],
  )

  return useReadable(notice)
}

interface Shown {
  notice: Pick<Notice, 'refresh' | 'close' | 'closable'>
  refresh: Readable<boolean>
}

const ShownNotice = createContext<Shown | undefined>(undefined)

function useShown(part: string): Shown {
  const shown = useContext(ShownNotice)

  if (!shown) {
    throw new Error(
      `[usher] <UpdateNotice.${part}> must be inside <UpdateNotice.Root>`,
    )
  }

  return shown
}

const SETTLE_MS = 100

const unseen: CSSProperties = {
  position: 'fixed',
  width: 1,
  height: 1,
  margin: -1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
}

function spoken(container: HTMLElement | null) {
  if (!container) {
    return ''
  }

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const words: string[] = []

  while (walker.nextNode()) {
    const node = walker.currentNode

    if (node instanceof Text && !node.parentElement?.closest('button')) {
      words.push(node.data)
    }
  }

  return words.join(' ').replaceAll(/\s+/g, ' ').trim()
}

interface AnnouncerProps {
  announce: Notice['announce'] | undefined
  container: RefObject<HTMLElement | null>
}

function Announcer({ announce, container }: AnnouncerProps) {
  const polite = useRef<HTMLOutputElement>(null)
  const assertive = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const text = spoken(container.current)

    const region = { off: undefined, polite, assertive }[announce ?? 'off']
    polite.current?.replaceChildren()
    assertive.current?.replaceChildren()

    const pending = setTimeout(
      () => region?.current?.replaceChildren(text),
      SETTLE_MS,
    )

    return () => clearTimeout(pending)
  }, [announce, container])

  return (
    <>
      <output ref={polite} aria-live="polite" aria-atomic style={unseen} />
      <div
        ref={assertive}
        role="alert"
        aria-live="assertive"
        aria-atomic
        style={unseen}
      />
    </>
  )
}

interface RootProps
  extends Omit<ComponentProps<'div'>, 'children'>, UpdateNoticeOptions {
  updates: AppUpdates
  children: (notice: Notice) => ReactNode
}

function Root(props: RootProps) {
  const { updates, minAttention, children, ...rest } = props
  const notice = useUpdateNotice(updates, { minAttention })
  const container = useRef<HTMLDivElement>(null)

  return (
    <>
      <Announcer announce={notice?.announce} container={container} />
      {notice && (
        <div
          ref={container}
          data-attention={notice.attention}
          data-reason={notice.reason}
          {...rest}
        >
          <ShownNotice.Provider value={{ notice, refresh: updates.refresh }}>
            {children(notice)}
          </ShownNotice.Provider>
        </div>
      )}
    </>
  )
}

function RefreshButton(props: ComponentProps<'button'>) {
  const { notice, refresh } = useShown('Refresh')
  const refreshing = useRefreshing(refresh)

  return (
    <button
      type="button"
      disabled={refreshing}
      data-refreshing={refreshing || undefined}
      onClick={() => void notice.refresh()}
      {...props}
    />
  )
}

function Close(props: ComponentProps<'button'>) {
  const { notice } = useShown('Close')

  return notice.closable ? (
    <button type="button" onClick={notice.close} {...props} />
  ) : null
}

/**
 * Headless parts for an update notice: `Root` renders while there is a notice
 * and announces it, `Refresh` is disabled while a refresh runs, and `Close`
 * renders nothing at urgent attention
 */
export const UpdateNotice = { Root, Refresh: RefreshButton, Close }
