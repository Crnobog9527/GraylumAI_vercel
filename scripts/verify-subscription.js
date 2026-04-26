/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

const { Client } = require('pg');

const sessionId = process.argv[2];
const email = process.argv[3];

function writeStdout(message) {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message) {
  process.stderr.write(`${message}\n`);
}

if (!sessionId || !email) {
  writeStderr('Usage: node scripts/verify-subscription.js <checkout_session_id> <email>');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  writeStderr('DATABASE_URL is required');
  process.exit(1);
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  const [order, relatedOrders, profile, transactions] = await Promise.all([
    client.query(
      `
        select
          id,
          item_type,
          billing_cycle,
          stripe_checkout_session_id,
          stripe_invoice_id,
          stripe_subscription_id,
          status,
          payment_status,
          fulfilled_at,
          amount_total,
          currency,
          updated_at
        from payment_orders
        where stripe_checkout_session_id = $1
      `,
      [sessionId],
    ),
    client.query(
      `
        select
          id,
          stripe_checkout_session_id,
          stripe_invoice_id,
          stripe_subscription_id,
          status,
          payment_status,
          fulfilled_at,
          created_at,
          updated_at
        from payment_orders
        where stripe_subscription_id = (
          select stripe_subscription_id
          from payment_orders
          where stripe_checkout_session_id = $1
        )
        order by created_at asc
      `,
      [sessionId],
    ),
    client.query(
      `
        select email, membership_level, credits
        from profiles
        where email = $1
      `,
      [email],
    ),
    client.query(
      `
        select id, amount, type, description, created_at
        from credit_transactions
        where user_id = (select id from profiles where email = $1)
        order by created_at desc
        limit 10
      `,
      [email],
    ),
  ]);

  writeStdout(
    JSON.stringify(
      {
        order: order.rows,
        relatedOrders: relatedOrders.rows,
        profile: profile.rows,
        transactions: transactions.rows,
      },
      null,
      2,
    )
  );

  await client.end();
}

main().catch((error) => {
  writeStderr(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
