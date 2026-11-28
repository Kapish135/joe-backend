import 'dotenv/config';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;
const [slugInput, ...nameParts] = process.argv.slice(2);
const slug = String(slugInput || '').trim().toLowerCase();
const name = nameParts.join(' ').trim();

if (!/^[a-z0-9-]{3,64}$/.test(slug) || !name) {
  console.error('Usage: npm run workspace:create -- <workspace-slug> "Business Name"');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : undefined
});

try {
  const result = await pool.query(
    `INSERT INTO joe.workspaces (id, slug, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING id, slug, name`,
    [randomUUID(), slug, name]
  );
  const workspace = result.rows[0];
  console.log(JSON.stringify({
    workspace,
    entryMessage: `JOIN ${workspace.slug}`,
    entryLink: `https://wa.me/${process.env.JOE_WHATSAPP_NUMBER || 'JOE_NUMBER'}?text=${encodeURIComponent(`JOIN ${workspace.slug}`)}`
  }, null, 2));
} finally {
  await pool.end();
}
