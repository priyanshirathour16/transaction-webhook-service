/**
 * Pre-flight check of the database connection strings. Run it before the first deploy and whenever
 * a connection problem is suspected:
 *
 *   npm run db:check
 *
 * Reads DATABASE_URL (the runtime string; Supabase transaction pooler, port 6543) and
 * DATABASE_URL_DIRECT (the migration string; Supabase session pooler, port 5432) from the
 * environment or from ./.env, then for each one reports whether it connects, how fast it answers,
 * and whether it points at the expected region. Passwords are never printed.
 */
import { existsSync } from 'node:fs';
import { parseDatabaseConfig } from '#src/config/env.js';
import { checkDatabase } from './lib/database-check.js';
import { formatMs } from './lib/stats.js';

const EXPECTED_REGION = process.env.EXPECTED_DB_REGION ?? 'ap-southeast-2';

if (existsSync('.env')) process.loadEnvFile('.env');

const config = parseDatabaseConfig(process.env);
const targets = [
  { label: 'DATABASE_URL        (runtime, used by the Lambdas)', url: config.DATABASE_URL },
  ...(config.DATABASE_URL_DIRECT
    ? [{ label: 'DATABASE_URL_DIRECT (migrations)', url: config.DATABASE_URL_DIRECT }]
    : []),
];

let allOk = true;
for (const target of targets) {
  const result = await checkDatabase({
    url: target.url,
    ssl: config.DB_SSL === 'require',
    expectedRegion: EXPECTED_REGION,
  });
  allOk &&= result.ok;

  console.log(`\n${target.label}`);
  console.log(
    `  endpoint   ${result.host}:${result.port}${result.region ? `  (${result.region})` : ''}`,
  );
  if (result.ok) {
    console.log(`  connection OK  PostgreSQL ${result.serverVersion}`);
    console.log(
      `  speed      first query incl. connecting ${formatMs(result.coldMs)}, then ~${formatMs(result.warmMs)} per query`,
    );
    console.log(
      `  schema     transactions table ${result.tablePresent ? 'present' : 'not created yet (run: npm run migrate)'}`,
    );
  } else {
    console.log(`  connection FAILED  ${result.error}`);
  }
  for (const warning of result.warnings) console.log(`  WARNING    ${warning}`);
  allOk &&= result.warnings.length === 0;
}

console.log(allOk ? '\nAll checks passed.' : '\nSome checks failed or warned. See above.');
process.exit(allOk ? 0 : 1);
