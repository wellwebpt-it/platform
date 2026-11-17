import { useEffect, useRef, useState } from 'react';

const steps = [
  { title: 'Encontre o perfil certo', eyebrow: '01 / DESCOBRIR', text: 'Pesquise profissionais e encontre o serviço ideal, filtrando por modalidade, localização, preço e disponibilidade.' },
  { title: 'O hotel solicita a sessão', eyebrow: '02 / RESERVAR', text: 'Envie o pedido e aguarde a confirmação da disponibilidade. Hotel e profissional recebem notificações sobre o agendamento.' },
  { title: 'O bem-estar vai até ao hotel', eyebrow: '03 / EXPERIENCIAR', text: 'Com hora e preço confirmados, o profissional desloca-se ao hotel para proporcionar uma experiência de bem-estar ao hóspede.' },
  { title: 'Partilhe a sua experiência', eyebrow: '04 / AVALIAR', text: 'Avaliação do profissional através de um link público, sem criar conta. Fortalece a reputação do profissional e aumenta a confiança dos alojamentos.', future: true },
];

export function WorkflowSection() {
  const section = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = section.current;
    if (!node || !('IntersectionObserver' in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { threshold: 0.15 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return <section ref={section} className={`about-workflow page-section${visible ? ' is-visible' : ''}`} aria-labelledby="workflow-title">
    <p className="eyebrow">COMO FUNCIONA</p>
    <h2 id="workflow-title">Da procura à experiência, em poucos passos.</h2>
    <ol className="workflow-steps">
      {steps.map(({ title, eyebrow, text, future }, index) => <li key={eyebrow} style={{ '--step-index': index } as React.CSSProperties}>
        <span className="workflow-eyebrow">{eyebrow}</span>
        <h3>{title}</h3>
        <p>{text}</p>
        {future && <span className="workflow-future">Funcionalidade futura</span>}
      </li>)}
    </ol>
  </section>;
}
