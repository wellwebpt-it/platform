export type RegistrationInput = {
  displayName: string; email: string; password: string; passwordConfirmation: string;
  phone: string; city: string; hotelName?: string; address?: string;
  serviceArea?: string; bio?: string; whatsappConsent?: boolean;
};

export const WHATSAPP_CONSENT_TEXT_VERSION = 'wellweb-whatsapp-operations-v1-2026-11-15';
export const WHATSAPP_CONSENT_TEXT = 'Aceito receber notificações operacionais da WellWeb através do WhatsApp, no número de telefone indicado, relacionadas com pedidos de reserva, confirmações, cancelamentos e prazos de resposta. Posso desativar estas notificações a qualquer momento nas definições do meu perfil.';
export const HOTEL_WHATSAPP_CONSENT_TEXT_VERSION = 'wellweb-hotel-whatsapp-operations-v1-2026-11-17';
export const HOTEL_WHATSAPP_CONSENT_TEXT = 'Aceito receber notificações operacionais da WellWeb através do WhatsApp, no número de telefone indicado, relacionadas com pedidos de reserva, confirmações, rejeições e cancelamentos. Posso desativar estas notificações a qualquer momento nas definições do meu perfil.';

export function normalizeInternationalPhone(value: string): string {
  return value.trim().replace(/[\s().-]/g, '');
}

export function validateRegistration(input: RegistrationInput, type: 'HOTEL' | 'PROFESSIONAL') {
  const errors: Record<string, string> = {};
  if (input.displayName.trim().length < 2) errors.displayName = 'Indica o teu nome.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) errors.email = 'Indica um email válido.';
  if (input.password.length < 10) errors.password = 'Usa pelo menos 10 caracteres.';
  if (input.password !== input.passwordConfirmation) errors.passwordConfirmation = 'As palavras-passe não coincidem.';
  if (!/^\+[1-9]\d{7,14}$/.test(normalizeInternationalPhone(input.phone))) errors.phone = 'Indica o indicativo internacional e o número, por exemplo +351 912345678.';
  if (input.city.trim().length < 2) errors.city = 'Indica a localidade.';
  if (type === 'HOTEL' && (input.hotelName?.trim().length ?? 0) < 2) errors.hotelName = 'Indica o nome do alojamento.';
  if (type === 'HOTEL' && (input.address?.trim().length ?? 0) < 4) errors.address = 'Indica a morada.';
  if (type === 'PROFESSIONAL' && (input.serviceArea?.trim().length ?? 0) < 2) errors.serviceArea = 'Indica a área de atuação.';
  return errors;
}

export function registrationMetadata(input: RegistrationInput, type: 'HOTEL' | 'PROFESSIONAL') {
  return {
    wellweb_signup: true,
    account_type: type,
    display_name: input.displayName.trim(),
    phone_e164: normalizeInternationalPhone(input.phone),
    city: input.city.trim(),
    ...(type === 'HOTEL' ? {
      hotel_name: input.hotelName?.trim(), address_line1: input.address?.trim(),
      ...(input.whatsappConsent ? {
        whatsapp_operational_consent: true,
        whatsapp_consent_text_version: HOTEL_WHATSAPP_CONSENT_TEXT_VERSION,
      } : {}),
    } : {
      service_area: input.serviceArea?.trim(), bio: input.bio?.trim() || null,
      ...(input.whatsappConsent ? {
        whatsapp_operational_consent: true,
        whatsapp_consent_text_version: WHATSAPP_CONSENT_TEXT_VERSION,
      } : {}),
    }),
  };
}
