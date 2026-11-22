import { useState } from 'react'
import { devtools } from './devtools'

const modes = ['advance', 'force', 'rollback', 'reset'] as const

export function DeployControls() {
  const [served, setServed] = useState<string>()

  if (!devtools) {
    return null
  }

  const { deploy } = devtools

  return (
    <section>
      <h2>Simulate a deploy</h2>
      <div className="row">
        {modes.map(mode => (
          <button
            key={mode}
            type="button"
            onClick={async () => setServed((await deploy({ mode })).version)}
          >
            {mode}
          </button>
        ))}
      </div>
      <p>
        {served
          ? `The dev server now serves ${served}. This tab notices on its next check, within 10 seconds.`
          : 'The dev server serves the build this tab runs.'}
      </p>
    </section>
  )
}
