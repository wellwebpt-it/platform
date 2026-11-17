import { ArrowRight } from 'lucide-react';
import type { AccountType, AccountStatus } from '../lib/access';

export function ProfessionalSignupCallout({ go, account }: {
  go: (path: string) => void;
  account: { account_type: AccountType; status: AccountStatus } | null;
}) {
  const path = account
    ? account.account_type === 'ADMIN' ? '/admin' : account.account_type === 'HOTEL' ? '/hotel' : '/profissional'
    : '/registar/profissional';
  const label = account ? 'Aceder à minha área' : 'Criar perfil profissional';
  return <section className="about-signup page-section" aria-labelledby="signup-title">
    <p className="eyebrow">FAZ PARTE DA COMUNIDADE</p>
    <h2 id="signup-title">Você profissional do wellness, seu talento merece ser encontrado!</h2>
    <button className="primary-button" type="button" onClick={() => go(path)}>{label}<ArrowRight size={17}/></button>
    <p>Os perfis profissionais passam por aprovação administrativa antes de serem publicados.</p>
  </section>;
}
