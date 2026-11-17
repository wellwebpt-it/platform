export function IntroSection() {
  return <section className="about-intro page-section" aria-labelledby="about-title">
    <h1 id="about-title" className="sr-only">Sobre a WellWeb</h1>
    <p className="eyebrow about-signature">WELLNESS · EXPERIENCES · CONNECTIONS</p>
    <div className="about-intro-copy">
      <article className="about-intro-card">
        <span aria-hidden="true">01</span>
        <p>A Wellweb nasceu com o propósito de aproximar pessoas, espaços e profissionais através de um compromisso comum com o <strong>bem-estar e a qualidade das experiências.</strong></p>
      </article>
      <article className="about-intro-card">
        <span aria-hidden="true">02</span>
        <p>Somos uma plataforma digital que conecta <strong>hotéis, alojamentos e espaços de hospitalidade</strong> a <strong>profissionais independentes de wellness</strong>, facilitando a descoberta e a contratação de serviços e experiências de bem-estar.</p>
      </article>
      <article className="about-intro-card">
        <span aria-hidden="true">03</span>
        <p>Acreditamos no poder das conexões para gerar <strong>novas oportunidades de negócio</strong>, valorizar <strong>talentos locais</strong> e contribuir para a rentabilidade e diferenciação dos espaços de hospitalidade.</p>
      </article>
    </div>
  </section>;
}
