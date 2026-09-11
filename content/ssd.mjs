// Editorial observations require a source reference and explicit India-time dates.
// Do not turn an empty list into a zero count, closure or release prediction.
export const observations = [];
export const sourceReviews = [{
  source: 'https://tirumalainfo.com/tirumala-live-status.php',
  reviewedOn: '2026-09-11',
  decision: 'hold',
  reason: 'Fixed 05:00 release copy conflicts with midnight issuance history. Darshan date and counter scope are unclear; percentage milestones are interpolated.'
}];
export const ssdQuestions = [
  ['What does the official balance mean?', 'It is the balance published for the displayed darshan date. It is not a reservation and is not a count for each counter. Availability can change while you travel or queue.'],
  ['Is the running slot a reporting time?', 'We display the slot label exactly as TTD publishes it. A label such as 1 or 12 is not converted into a clock time. Follow the reporting time printed on your token.'],
  ['When will the next tokens be issued?', 'The live balance does not establish the next release time. No fixed daily countdown is shown without a current dated official announcement.'],
  ['Which date should I plan around?', 'Keep the token collection date separate from the darshan date. Read the date, time and reporting point on your own token before arranging onward travel.'],
  ['What identification should I bring?', 'Carry original identification. Confirm accepted documents and whether every pilgrim must attend in person with TTD. Requirements for children and visitors without Aadhaar need individual confirmation.'],
  ['How long will I wait?', 'The queue to collect a token and the queue after reporting for darshan are different waits. Neither can be calculated from the remaining token balance. Tokenless Sarva Darshan estimates do not describe SSD waiting time.'],
  ['What if the balance is zero?', 'Zero describes the displayed official date at the last check. It does not prove that every counter is closed or that no further slot will be released. Confirm arrangements with TTD before changing your travel plans.'],
  ['Can I get another token after a recent visit?', 'Current repeat-visit eligibility has not been verified here. Ask TTD before joining the queue; do not rely on an old notice or a rule for another darshan category.']
];
export function validateObservation(record) {
  if (record.type !== 'SSD' || !record.id || !record.sourceReference || !record.counter
    || !['darshanDate','issuanceDate'].every(key => {
      const value = record[key];
      const date = new Date(`${value}T00:00:00Z`);
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.valueOf()) && date.toISOString().slice(0,10) === value;
    })
    || !['observedAt','reportedAt','reviewedAt'].every(key => typeof record[key] === 'string' && /(?:Z|\+05:30)$/.test(record[key]) && Number.isFinite(Date.parse(record[key])))
    || Date.parse(record.observedAt) > Date.parse(record.reportedAt)
    || Date.parse(record.reportedAt) > Date.parse(record.reviewedAt)
    || !record.summary) throw new Error('Incomplete SSD observation');
  return record;
}
