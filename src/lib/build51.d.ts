export function groupBookingTotal(input: { price: number | null | undefined; allowsGroup: boolean; pricePerStudent: boolean; students: number }): number | null;
export function canCancelBooking(input: { role: 'HOTEL'|'PROFESSIONAL'|string; status: string; startsAt: string | number; now?: number }): boolean;
