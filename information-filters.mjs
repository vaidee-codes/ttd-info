export function indiaDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
export function matches(item, { query = '', month = '', temple = '' } = {}) {
  const terms = query.toLocaleLowerCase('en').trim().split(/\s+/).filter(Boolean);
  const text = (item.text || '').toLocaleLowerCase('en');
  const startMonth = (item.date || '').slice(0,7);
  const endMonth = (item.endDate || item.date || '').slice(0,7);
  return terms.every(term => text.includes(term)) && (!month || (startMonth <= month && endMonth >= month)) && (!temple || item.temple === temple);
}
export function eventStatus(date, endDate, today) {
  if(!date) return 'Date awaiting confirmation';
  if((endDate || date) < today) return 'Past event';
  if(date <= today && (endDate || date) >= today) return 'Scheduled today · confirm with TTD';
  return 'Upcoming · published schedule';
}
