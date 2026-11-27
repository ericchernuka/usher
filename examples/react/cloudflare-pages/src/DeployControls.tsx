import { useState } from 'react'

const modes = ['advance', 'force', 'rollback', 'reset'] as const

export function DeployControls() {
  const [served, setServed] = useState<string>()

  const devtools = globalThis.__USHER_DEVTOOLS__

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
          ? `The dev server now serves ${served}. This app notices on its next check, within 10 seconds.`
          : 'The dev server serves the build this app is running.'}
      </p>
    </section>
  )
}
