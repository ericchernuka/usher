import { useState } from 'react'
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

function Body({ notice }: { notice: Notice }) {
  const [blocked, setBlocked] = useState(false)
  const { title, description } = copyFor(notice)

  async function refresh() {
    setBlocked((await notice.refresh()) === 'blocked')
  }

  return (
    <>
      <div>
        <strong>{title}</strong>
        <p>{blocked ? 'Clear your draft first, then refresh.' : description}</p>
      </div>
      <UpdateNotice.Refresh onClick={() => void refresh()}>
        Refresh
      </UpdateNotice.Refresh>
      <UpdateNotice.Close aria-label="Close">×</UpdateNotice.Close>
    </>
  )
}

export function UpdateBanner() {
  return (
    <UpdateNotice.Root
      className="banner"
      updates={appUpdates}
      minAttention="passive"
    >
      {notice => (
        <Body key={`${notice.attention}:${notice.reason}`} notice={notice} />
      )}
    </UpdateNotice.Root>
  )
}
