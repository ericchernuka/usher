import { useState } from 'react'
import { useRefreshBlocker } from '@rndsqr/react-usher'
import { appUpdates } from './updates'

export function Draft() {
  const [draft, setDraft] = useState('')
  useRefreshBlocker(appUpdates.refresh, draft !== '')

  return (
    <section>
      <h2>Unsaved work</h2>
      <label>
        Draft
        <textarea
          value={draft}
          onChange={event => setDraft(event.target.value)}
        />
      </label>
      <p>
        {draft === ''
          ? 'Nothing blocks a refresh.'
          : 'This draft blocks a refresh until you clear it.'}
      </p>
    </section>
  )
}
