import {
  createContext,
  use,
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useSyncExternalStore,
  useTransition,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from 'react'
import {
  createUpdateNotice,
  type AppUpdates,
  type Readable,
  type Refresh,
  type RefreshBlocker,
  type RefreshOutcome,
  type UpdateNotice as Notice,
  type UpdateNoticeOptions,
  type UpdateState,
} from '@rndsqr/usher-core'
import { claim, prepareAnnouncements, release, spoken } from './announcer'

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
  const blocks = useEffectEvent(
    () => shouldBlock === true || (shouldBlock !== false && shouldBlock()),
  )

  const registered = shouldBlock !== false

  useEffect(
    () => (registered ? refresh.addBlocker(() => blocks()) : undefined),
    [refresh, registered],
  )
}

/**
 * Read the notice to show, for a component that renders its own markup,
 * deferred so its arrival never blocks input
 */
export function useUpdateNotice(
  updates: AppUpdates,
  options: UpdateNoticeOptions = {},
): Notice | undefined {
  const { minAttention } = options

  const notice = useMemo(
    () => createUpdateNotice(updates, { minAttention }),
    [updates, minAttention],
  )

  return useDeferredValue(useReadable(notice))
}

interface Shown {
  notice: Pick<Notice, 'refresh' | 'close' | 'closable'>
  refresh: Readable<boolean>
}

const ShownNotice = createContext<Shown | undefined>(undefined)

function useShown(part: string): Shown {
  const shown = use(ShownNotice)

  if (!shown) {
    throw new Error(
      `[usher] <UpdateNotice.${part}> must be inside <UpdateNotice.Root>`,
    )
  }

  return shown
}

function forward<Node>(ref: Ref<Node> | undefined, node: Node | null) {
  if (ref && 'current' in ref) {
    ref.current = node
  } else {
    ref?.(node)
  }
}

function useAnnouncement(
  element: HTMLElement | null,
  priority: Notice['announce'] | undefined,
) {
  useEffect(() => {
    prepareAnnouncements(document)
  }, [])

  useEffect(() => {
    if (!element || !priority || priority === 'off') {
      return undefined
    }

    const sync = () => {
      const text = spoken(element)

      if (text) {
        claim(element, priority, text)
      } else {
        release(element)
      }
    }

    const wording = new MutationObserver(sync)
    const hiding = new MutationObserver(sync)
    const size = new ResizeObserver(sync)

    wording.observe(element, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    })

    hiding.observe(element.ownerDocument.documentElement, {
      subtree: true,
      attributeFilter: ['aria-hidden', 'hidden'],
    })

    size.observe(element)
    sync()

    return () => {
      wording.disconnect()
      hiding.disconnect()
      size.disconnect()
      release(element)
    }
  }, [element, priority])
}

interface RootProps
  extends Omit<ComponentProps<'div'>, 'children'>, UpdateNoticeOptions {
  /** The app's updates */
  updates: AppUpdates
  /** Markup for the notice, called only while there is one */
  children: (notice: Notice) => ReactNode
}

function Root(props: RootProps) {
  const { updates, minAttention, children, ref, ...rest } = props
  const notice = useUpdateNotice(updates, { minAttention })
  const [element, setElement] = useState<HTMLDivElement | null>(null)

  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      setElement(node)
      forward(ref, node)
    },
    [ref],
  )

  useAnnouncement(element, notice?.announce)

  if (!notice) {
    return null
  }

  return (
    <div
      data-attention={notice.attention}
      data-reason={notice.reason}
      {...rest}
      ref={attach}
    >
      <ShownNotice value={{ notice, refresh: updates.refresh }}>
        {children(notice)}
      </ShownNotice>
    </div>
  )
}

interface RefreshProps extends ComponentProps<'button'> {
  /**
   * What a press does in place of refreshing, given the refresh to call, and
   * awaited in a transition that keeps the button pending, so it must settle
   * because React holds every transition pending until all Actions complete
   */
  action?: (refresh: () => Promise<RefreshOutcome>) => void | Promise<void>
}

function RefreshButton({ action, onClick, ...props }: RefreshProps) {
  const { notice, refresh } = useShown('Refresh')
  const refreshing = useRefreshing(refresh)
  const [pending, startTransition] = useTransition()
  const busy = refreshing || pending

  return (
    <button
      type="button"
      disabled={busy}
      data-refreshing={busy || undefined}
      {...props}
      onClick={event => {
        onClick?.(event)

        if (action) {
          startTransition(async () => {
            await action(notice.refresh)
          })
        } else {
          void notice.refresh()
        }
      }}
    />
  )
}

function Close({ onClick, ...props }: ComponentProps<'button'>) {
  const { notice } = useShown('Close')

  return notice.closable ? (
    <button
      type="button"
      {...props}
      onClick={event => {
        onClick?.(event)
        notice.close()
      }}
    />
  ) : null
}

/**
 * Headless parts for an update notice: `Root` renders while there is a notice
 * and announces it, `Refresh` runs its `action` or a refresh and is disabled
 * meanwhile, and `Close` renders nothing at urgent attention
 */
export const UpdateNotice = { Root, Refresh: RefreshButton, Close }
