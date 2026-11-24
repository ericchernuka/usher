import {
  createContext,
  use,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useSyncExternalStore,
  useTransition,
  type ComponentProps,
  type ReactNode,
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
} from '@ericchernuka/usher-core'

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
 * Block refreshes while the component's effects are active, with a boolean or
 * a function that may be written inline because the latest one is called
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
 * Read the notice to show, for a component that renders its own markup, not
 * deferred because its `refresh` and `close` have to be the current ones
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

  return useReadable(notice)
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

const SETTLE_MS = 100

const unseen = {
  position: 'fixed',
  width: '1px',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
}

interface AnnouncerProps {
  priority: Notice['announce'] | undefined
  wording: string
}

function Announcer({ priority, wording }: AnnouncerProps) {
  const polite = useRef<HTMLOutputElement>(null)
  const assertive = useRef<HTMLDivElement>(null)

  useEffect(() => {
    for (const region of [polite.current, assertive.current]) {
      if (region) {
        Object.assign(region.style, unseen)
        region.hidden = false
      }
    }
  }, [])

  useEffect(() => {
    const region = { off: undefined, polite, assertive }[priority ?? 'off']
      ?.current

    if (!region || !wording) {
      return undefined
    }

    const pending = setTimeout(() => region.replaceChildren(wording), SETTLE_MS)

    return () => {
      clearTimeout(pending)
      region.replaceChildren()
    }
  }, [priority, wording])

  return (
    <>
      <output ref={polite} aria-live="polite" hidden />
      <div ref={assertive} role="alert" aria-live="assertive" hidden />
    </>
  )
}

interface RootProps
  extends Omit<ComponentProps<'div'>, 'children'>, UpdateNoticeOptions {
  /** The app's updates */
  updates: AppUpdates
  /**
   * Wording a screen reader hears when the notice appears or the wording
   * changes, politely for a prompt and assertively for urgent attention,
   * with an empty string for a root that should stay silent, as one given
   * `hidden`, `inert` or `aria-hidden` always does
   */
  announcement: (notice: Notice) => string
  /** Markup for the notice, called only while there is one */
  children: (notice: Notice) => ReactNode
}

function Root(props: RootProps) {
  const { updates, minAttention, announcement, children, ...rest } = props
  const notice = useUpdateNotice(updates, { minAttention })
  const hiding = rest['aria-hidden']

  const silent =
    rest.hidden === true ||
    rest.inert === true ||
    hiding === true ||
    hiding === 'true'

  return (
    <>
      <Announcer
        priority={notice?.announce}
        wording={notice && !silent ? announcement(notice) : ''}
      />
      {notice && (
        <div
          data-attention={notice.attention}
          data-reason={notice.reason}
          {...rest}
        >
          <ShownNotice value={{ notice, refresh: updates.refresh }}>
            {children(notice)}
          </ShownNotice>
        </div>
      )}
    </>
  )
}

interface RefreshProps extends ComponentProps<'button'> {
  /**
   * What a press does in place of refreshing, given the refresh to call, and
   * awaited in a transition that keeps the button pending, so it must settle
   * because React holds overlapping transitions pending until all Actions end
   */
  action?: (refresh: () => Promise<RefreshOutcome>) => void | Promise<void>
}

function RefreshButton(props: RefreshProps) {
  const { action, onClick, disabled, ...rest } = props
  const { notice, refresh } = useShown('Refresh')
  const refreshing = useRefreshing(refresh)
  const [pending, startTransition] = useTransition()
  const busy = refreshing || pending

  return (
    <button
      type="button"
      data-refreshing={busy || undefined}
      {...rest}
      disabled={busy || disabled === true}
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
 * and announces its `announcement`, `Refresh` runs its `action` or a refresh and is disabled
 * meanwhile, and `Close` renders nothing at urgent attention
 */
export const UpdateNotice = { Root, Refresh: RefreshButton, Close }
