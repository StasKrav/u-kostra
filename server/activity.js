import { queries } from './db.js';

// Активность = люди (0..10) + свежие реплики (0..10) + бонус свежести (0..5)
export function computeActivity(gladeId) {
  const people = queries.countPresence.get(gladeId).n;
  const messages = queries.countRecentMessages.get(gladeId).n;
  const last = queries.lastMessageAt.get(gladeId).t;

  const peopleWeight = Math.min(people, 10);
  const messagesWeight = Math.min(messages, 20) * 0.5;

  let recencyBonus = 0;
  if (last) {
    const ago = Math.floor(Date.now() / 1000) - last;
    if (ago < 60) recencyBonus = 5;
    else if (ago < 300) recencyBonus = 2;
  }

  return Math.round(peopleWeight + messagesWeight + recencyBonus);
}
