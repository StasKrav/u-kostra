import { randomBytes } from 'node:crypto';
import { queries } from './db.js';

const COOKIE_NAME = 'koster_token';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

export function getOrCreateUser(req, res) {
  let token = req.cookies?.[COOKIE_NAME];

  if (token) {
    const user = queries.findUserByToken.get(token);
    if (user) {
      queries.touchUser.run(user.id);
      return user;
    }
  }

  token = randomBytes(24).toString('hex');
  const info = queries.createUser.run(token);
  const user = queries.findUserByToken.get(token);

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_MS,
  });

  return user;
}

export function findUserByToken(token) {
  if (!token) return null;
  return queries.findUserByToken.get(token) || null;
}

export const COOKIE = COOKIE_NAME;
