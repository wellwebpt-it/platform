const zone = 'Europe/Lisbon';

export function parseLisbonDateTime(dateText: string, timeText: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateText.trim());
  const time = /^(\d{2}):(\d{2})$/.exec(timeText.trim());
  if (!match || !time) throw new Error('Indica a data como DD/MM/AAAA e a hora como HH:MM.');
  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText), month = Number(monthText), year = Number(yearText);
  const hour = Number(time[1]), minute = Number(time[2]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59)
    throw new Error('A data ou a hora indicada não é válida.');

  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let guess = desired;
  for (let index = 0; index < 5; index++) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess));
    const read = (type: string) => Number(parts.find(part => part.type === type)?.value);
    const represented = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'));
    const delta = desired - represented;
    if (delta === 0) break;
    guess += delta;
  }
  const result = new Date(guess);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(result);
  const read = (type: string) => Number(parts.find(part => part.type === type)?.value);
  if (read('year') !== year || read('month') !== month || read('day') !== day || read('hour') !== hour || read('minute') !== minute)
    throw new Error('Esta hora local não existe devido à mudança de hora. Escolhe outro horário.');
  return result.toISOString();
}

export function formatLisbonDateInput(value: string): string {
  const parts = new Intl.DateTimeFormat('pt-PT', { timeZone: zone, day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(new Date(value));
  const read = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${read('day')}/${read('month')}/${read('year')}`;
}

export function formatLisbonTimeInput(value: string): string {
  return new Intl.DateTimeFormat('pt-PT', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}

export function toLisbonLocalDateTime(value: string): string {
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value));
  const read=(type:string)=>parts.find(part=>part.type===type)?.value??'';
  return `${read('year')}-${read('month')}-${read('day')}T${read('hour')}:${read('minute')}`;
}
