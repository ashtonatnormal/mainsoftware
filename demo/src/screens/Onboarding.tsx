// Placeholder — replaced by the real screen.
import { Page, EmptyState } from '../ui'
import { useStore } from '../store'

export default function OnboardingScreen() {
  const { completeOnboarding } = useStore()
  return (
    <Page>
      <EmptyState title="Onboarding" body="Coming soon in the demo." action={<button onClick={completeOnboarding}>Skip</button>} />
    </Page>
  )
}
