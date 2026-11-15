import { ArrowRight, MapPin, UserRound } from 'lucide-react';
import { publicImageUrl } from '../lib/media';
import { formatStartingServicePrice, type AvailabilitySummary } from '../lib/featuredProfessionals';
import { AvailabilityBadge } from './AvailabilityBadge';
import { ReviewRatingSummary } from '../Reviews';

export type PublicProfessional = {
  id: string;
  public_name: string;
  city: string;
  service_area: string;
  description: string | null;
  services: string[];
  modalities: string[];
  primary_photo_path: string | null;
  published_at: string | null;
  guest_rating_average:number|null; guest_rating_count:number; hotel_rating_average:number|null; hotel_rating_count:number;
  service_details: { id: string; name: string; duration_minutes: number | null; price: number | null; currency: string; allows_group: boolean; price_per_student: boolean }[];
};

export function ProfessionalCard({ profile, summary, onOpen }: {
  profile: PublicProfessional;
  summary?: AvailabilitySummary;
  onOpen: () => void;
}) {
  const photo = publicImageUrl(profile.primary_photo_path);
  const serviceNames = profile.services.slice(0, 2);
  const startingPrice = formatStartingServicePrice(profile.service_details);
  return <article className="about-professional-card">
    <button className="about-professional-open" type="button" onClick={onOpen} aria-label={`Abrir perfil público de ${profile.public_name}`}>
      <span className="about-professional-photo">
        {photo ? <img src={photo} alt={`Fotografia de ${profile.public_name}`} loading="lazy"/> : <span className="about-photo-placeholder"><UserRound size={32}/></span>}
        <AvailabilityBadge summary={summary} className="availability-badge-photo"/>
      </span>
      <span className="about-professional-body">
        <span className="about-professional-location"><MapPin size={14} aria-hidden="true"/>{profile.city}</span>
        <strong className="about-professional-name">{profile.public_name}</strong>
        <ReviewRatingSummary summary={profile}/>
        <span className="about-professional-area">{profile.service_area}</span>
        <span className="about-professional-tags">{profile.modalities.slice(0, 3).map((item) => <span key={item}>{item}</span>)}</span>
        {profile.description && <span className="about-professional-description">{profile.description}</span>}
        {serviceNames.length > 0 && <span className="about-professional-services">{serviceNames.join(' · ')}</span>}
        <span className="about-professional-card-footer">
          <span className="about-professional-starting-price">{startingPrice ?? 'Consultar serviços'}</span>
          <span className="about-professional-link">Ver perfil <ArrowRight size={15} aria-hidden="true"/></span>
        </span>
      </span>
    </button>
  </article>;
}
