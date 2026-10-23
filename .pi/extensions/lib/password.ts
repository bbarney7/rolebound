import { randomInt } from "node:crypto";

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGITS = "23456789";
const SPECIAL = "!@#$%^&*";

function pick(pool: string): string {
  return pool[randomInt(pool.length)];
}

function shuffle(value: string): string {
  const chars = value.split("");
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** Strong ATS-style password using cryptographic randomness. */
export function generatePassword(length = 14): string {
  const all = UPPER + LOWER + DIGITS + SPECIAL;
  let pw = pick(UPPER) + pick(LOWER) + pick(DIGITS) + pick(SPECIAL);
  while (pw.length < length) pw += pick(all);
  return shuffle(pw);
}

export function passwordMeetsAtsRequirements(password: string): boolean {
  return password.length >= 12
    && /[A-Z]/.test(password)
    && /[a-z]/.test(password)
    && /\d/.test(password)
    && /[!@#$%^&*]/.test(password);
}
