import { startTransition, useState } from 'react'
import { UpdateNotice } from '@rndsqr/react-usher'
import type { UpdateNotice as Notice } from '@rndsqr/usher-core'
import { appUpdates } from './updates'

function copyFor({ attention, reason }: Notice) {
  if (reason === 'rollback' || reason === 'forced') {
    return {
      title: 'Please refresh',
      description: 'This version has a known issue. Refresh to get the fix.',
    }
  }

  if (attention === 'urgent') {
    return {
      title: 'Please refresh',
      description: "You're on an old version of the app. Refresh to update.",
    }
  }

  return {
    title: 'A new version is available',
    description: "Refresh when you're ready.",
  }
}

const keyOf = (notice: Notice) => `${notice.attention}:${notice.reason}`

export function UpdateBanner() {
  const [blockedAt, setBlockedAt] = useState<string>()

  const copy = (notice: Notice) => ({
    ...copyFor(notice),
    ...(blockedAt === keyOf(notice) && {
      description: 'Clear your draft first, then refresh.',
    }),
  })

  return (
    <UpdateNotice.Root
      className="banner"
      updates={appUpdates}
      minAttention="passive"
      announcement={notice =>
        `${copy(notice).title}. ${copy(notice).description}`
      }
    >
      {notice => (
        <>
          <div>
            <strong>{copy(notice).title}</strong>
            <p>{copy(notice).description}</p>
          </div>
          <UpdateNotice.Refresh
            action={async refresh => {
              const outcome = await refresh()

              startTransition(() =>
                setBlockedAt(outcome === 'blocked' ? keyOf(notice) : undefined),
              )
            }}
          >
            Refresh
          </UpdateNotice.Refresh>
          <UpdateNotice.Close aria-label="Close">×</UpdateNotice.Close>
        </>
      )}
    </UpdateNotice.Root>
  )
}
