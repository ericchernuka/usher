import { useRefreshing, useUpdateState } from '@ericchernuka/react-usher'
import { runningBuild } from '@ericchernuka/usher-plugin/client'
import { DeployControls } from './DeployControls'
import { Draft } from './Draft'
import { UpdateBanner } from './UpdateBanner'
import { appUpdates } from './updates'
import './app.css'

function App() {
  const { attention, reason, latest } = useUpdateState(appUpdates.state)
  const refreshing = useRefreshing(appUpdates.refresh)

  return (
    <main>
      <h1>Workers example</h1>
      <UpdateBanner />
      <section>
        <h2>Update state</h2>
        <p>Attention: {attention}</p>
        <p>Reason: {reason}</p>
        <p>Running build: {runningBuild.version}</p>
        <p>Latest build: {latest?.version ?? 'not checked yet'}</p>
        <p>Refreshing: {refreshing ? 'yes' : 'no'}</p>
      </section>
      <DeployControls />
      <Draft />
    </main>
  )
}

export default App
