export type RegistrationInput = {
  displayName: string; email: string; password: string; passwordConfirmation: string;
  phone: string; city: string; hotelName?: string; address?: string;
  serviceArea?: string; bio?: string;
};

export function validateRegistration(input: RegistrationInput, type: 'HOTEL' | 'PROFESSIONAL') {
  const errors: Record<string, string> = {};
  if (input.displayName.trim().length < 2) errors.displayName = 'Indica o teu nome.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) errors.email = 'Indica um email válido.';
  if (input.password.length < 10) errors.password = 'Usa pelo menos 10 caracteres.';
  if (input.password !== input.passwordConfirmation) errors.passwordConfirmation = 'As palavras-passe não coincidem.';
  if (!/^\+[1-9]\d{7,14}$/.test(input.phone.trim())) errors.phone = 'Usa o formato internacional, por exemplo +351912345678.';
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
    phone_e164: input.phone.trim(),
    city: input.city.trim(),
    ...(type === 'HOTEL' ? { hotel_name: input.hotelName?.trim(), address_line1: input.address?.trim() } : {
      service_area: input.serviceArea?.trim(), bio: input.bio?.trim() || null,
    }),
  };
}
