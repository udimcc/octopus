import { useEffect, useState } from 'react'

// V0 placeholder shell. The real component tree — ProgressPanel + TaskWorkspace
// (DESIGN §5.1) — lands in V1. This also exercises the preload bridge so the
// end-to-end wiring is visibly working.
export function App(): React.JSX.Element {
  const [bridge, setBridge] = useState<string>('…')

  useEffect(() => {
    window.octopusAPI
      .ping()
      .then(setBridge)
      .catch(() => setBridge('unavailable'))
  }, [])

  return (
    <main>
      <h1>Octopus</h1>
      <p>Bridge: {bridge}</p>
    </main>
  )
}
