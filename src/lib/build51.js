/** Calculate an EUR service total using integer cents. */
export function groupBookingTotal({ price, allowsGroup, pricePerStudent, students }) {
  if (price === null || price === undefined) return null;
  if (!Number.isFinite(price) || price < 0) throw new Error('Preço inválido.');
  if (!Number.isInteger(students) || students < 1) throw new Error('Indica um número válido de alunos.');
  const cents = Math.round(price * 100);
  return (allowsGroup && pricePerStudent ? cents * students : cents) / 100;
}

/** Enforce role/state/time rules in the interface; the database remains authoritative. */
export function canCancelBooking({ role, status, startsAt, now = Date.now() }) {
  if (role === 'PROFESSIONAL' && status !== 'CONFIRMED') return false;
  if (role === 'HOTEL' && !['PENDING', 'CONFIRMED'].includes(status)) return false;
  if (!['HOTEL', 'PROFESSIONAL'].includes(role)) return false;
  const hours = role === 'PROFESSIONAL' ? 24 : 12;
  return new Date(startsAt).getTime() - now >= hours * 60 * 60 * 1000;
}
