import crypto from 'crypto';
import { prisma } from './prisma.js';
import { buildPaystackInitializeBody } from './paystackInitialize.js';

export function newPaystackReference() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Create pending Payment + legacy Transaction rows for a server-priced checkout,
 * then initialize the Paystack transaction. Amounts are always ZAR.
 */
export async function initializeServerPaystackPayment({
  userId,
  amountZar,
  metadata,
  reference = newPaystackReference(),
  paymentType = 'other',
}) {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) {
    const err = new Error('Paystack is not configured');
    err.status = 500;
    throw err;
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  const email = user?.email || 'user@secnightlife.app';
  const amountInCents = Math.round(amountZar * 100);
  await prisma.payment.create({
    data: {
      userId,
      email,
      amount: amountZar,
      reference,
      status: 'pending',
      type: paymentType,
      metadata: { user_id: userId, ...metadata },
    },
  });
  await prisma.transaction.create({
    data: {
      userId,
      amount: amountZar,
      currency: 'ZAR',
      type: 'paystack',
      status: 'pending',
      stripeId: reference,
      metadata: { provider: 'paystack', reference, ...metadata },
    },
  });
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(
      buildPaystackInitializeBody({ email, amountInCents, reference, userId, metadata }),
    ),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.status) {
    const err = new Error(data?.message || 'Paystack request failed');
    err.status = res.status >= 400 && res.status < 500 ? 502 : res.status;
    throw err;
  }
  return {
    reference,
    email,
    authorization_url: data.data.authorization_url,
    access_code: data.data.access_code,
    amount_zar: amountZar,
  };
}
