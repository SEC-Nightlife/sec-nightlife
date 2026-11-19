/**
 * Pick the unverified account a resend should update.
 * Party Goer (USER) and Business Owner (VENUE) are separate rows on one email.
 * @param {Array<{ id: string, role: string, emailVerified?: boolean, deletedAt?: Date | null }>} accounts
 * @param {'USER' | 'VENUE' | undefined} role
 */
export function selectVerificationAccount(accounts, role) {
  const rows = (Array.isArray(accounts) ? accounts : []).filter((row) => row && !row.deletedAt);
  const scoped = role ? rows.filter((row) => row.role === role) : rows;
  if (!scoped.length) return { code: 'NOT_FOUND' };
  const unverified = scoped.filter((row) => !row.emailVerified);
  if (unverified.length > 1) return { code: 'ROLE_REQUIRED' };
  if (unverified.length === 1) return { code: 'SEND', user: unverified[0] };
  return { code: 'ALREADY_VERIFIED' };
}
