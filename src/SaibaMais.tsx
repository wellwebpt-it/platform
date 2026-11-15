import type { AccountStatus, AccountType } from './lib/access';
import { IntroSection } from './saiba-mais/IntroSection';
import { WorkflowSection } from './saiba-mais/WorkflowSection';
import { ProfessionalCarousel } from './saiba-mais/ProfessionalCarousel';
import { ProfessionalSignupCallout } from './saiba-mais/ProfessionalSignupCallout';

export function SaibaMais({ go, account }: {
  go: (path: string) => void;
  account: { account_type: AccountType; status: AccountStatus } | null;
}) {
  return <div className="about-page">
    <IntroSection/>
    <WorkflowSection/>
    <ProfessionalCarousel go={go}/>
    <ProfessionalSignupCallout go={go} account={account}/>
  </div>;
}
