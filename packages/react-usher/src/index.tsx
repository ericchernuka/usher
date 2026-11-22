import {
  createContext,
  useContext,
  useDeferredValue,
  useId,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ComponentProps,
  type MouseEvent,
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
import { announce, prepareAnnouncements, spoken, withdraw } from './announcer'

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

function useAnnouncement(id: string, priority: Notice['announce'] | undefined) {
  useEffect(() => {
    prepareAnnouncements()
  }, [])

  useEffect(() => {
    const container = document.querySelector(`[data-usher-notice="${id}"]`)

    if (!container || !priority || priority === 'off') {
      return undefined
    }

    let said = ''

    const sync = () => {
      const text = spoken(container)

      if (text === said) {
        return
      }

      said = text

      if (text) {
        announce(id, priority, text)
      } else {
        withdraw(id)
      }
    }

    const observer = new MutationObserver(sync)

    observer.observe(container, {
      subtree: true,
      childList: true,
      characterData: true,
    })

    sync()

    return () => {
      observer.disconnect()
      withdraw(id)
    }
  }, [id, priority])
}

interface RootProps
  extends Omit<ComponentProps<'div'>, 'children'>, UpdateNoticeOptions {
  /** The app's updates */
  updates: AppUpdates
  /** Markup for the notice, called only while there is one */
  children: (notice: Notice) => ReactNode
}

function Root(props: RootProps) {
  const { updates, minAttention, children, ...rest } = props
  const notice = useUpdateNotice(updates, { minAttention })
  const id = useId()
  useAnnouncement(id, notice?.announce)

  if (!notice) {
    return null
  }

  return (
    <div
      data-attention={notice.attention}
      data-reason={notice.reason}
      {...rest}
      data-usher-notice={id}
    >
      <ShownNotice.Provider value={{ notice, refresh: updates.refresh }}>
        {children(notice)}
      </ShownNotice.Provider>
    </div>
  )
}

type ButtonProps = ComponentProps<'button'>

const unlessPrevented =
  (onClick: ButtonProps['onClick'], act: () => void) =>
  (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event)

    if (!event.defaultPrevented) {
      act()
    }
  }

function RefreshButton({ onClick, ...props }: ButtonProps) {
  const { notice, refresh } = useShown('Refresh')
  const refreshing = useRefreshing(refresh)

  return (
    <button
      type="button"
      disabled={refreshing}
      data-refreshing={refreshing || undefined}
      {...props}
      onClick={unlessPrevented(onClick, () => void notice.refresh())}
    />
  )
}

function Close({ onClick, ...props }: ButtonProps) {
  const { notice } = useShown('Close')

  return notice.closable ? (
    <button
      type="button"
      {...props}
      onClick={unlessPrevented(onClick, notice.close)}
    />
  ) : null
}

/**
 * Headless parts for an update notice: `Root` renders while there is a notice
 * and announces it, `Refresh` is disabled while a refresh runs, and `Close`
 * renders nothing at urgent attention. A part's `onClick` runs first and can
 * call `preventDefault()` to take over
 */
export const UpdateNotice = { Root, Refresh: RefreshButton, Close }
