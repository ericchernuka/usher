import { useAppUpdates } from '@app-version/react'
import { appUpdates } from './updates'

function App() {
  const attention = useAppUpdates(appUpdates, s => s.attention)

  return (
    <main>
      <h1>Pages example</h1>
      <p>Attention: {attention}</p>
    </main>
  )
}

export default App
