export type AccountType = 'HOTEL' | 'PROFESSIONAL' | 'ADMIN';
export type AccountStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED';

export function accountHome(type: AccountType) {
  if (type === 'HOTEL') return '/hotel';
  if (type === 'PROFESSIONAL') return '/profissional';
  return '/admin';
}

export function canShowAccountArea(type: AccountType | null | undefined, status: AccountStatus | null | undefined, area: 'HOTEL' | 'PROFESSIONAL') {
  return status === 'ACTIVE' && type === area;
}

export function canAccessPath(type: AccountType | null, status: AccountStatus | null, path: string) {
  if (path === '/hotel') return type === 'HOTEL' && status === 'ACTIVE';
  if (path === '/profissional') return type === 'PROFESSIONAL' && status === 'ACTIVE';
  if (path === '/admin') return type === 'ADMIN' && status === 'ACTIVE';
  if (path === '/reservas') return (type === 'HOTEL' || type === 'PROFESSIONAL') && status === 'ACTIVE';
  if (path.startsWith('/area/')) return type === 'PROFESSIONAL' && status === 'ACTIVE';
  if (path.startsWith('/reservar/')) return type === 'HOTEL' && status === 'ACTIVE';
  return true;
}
