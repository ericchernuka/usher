import { useUpdateState } from '@rndsqr/react-usher'
import { appUpdates } from './updates'

function App() {
  const { attention } = useUpdateState(appUpdates)

  return (
    <main>
      <h1>Pages example</h1>
      <p>Attention: {attention}</p>
    </main>
  )
}

export default App
