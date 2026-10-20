import { describe, expect, it } from 'vitest';
import {
  describeEndpoint,
  poolerRegion,
  redact,
  regionWarnings,
} from '../../../scripts/lib/database-check.js';

const mumbai =
  'postgresql://postgres.exampleprojectrefaaaa:s3cretPassw0rd@aws-0-ap-south-1.pooler.supabase.com:6543/postgres';
const seoul =
  'postgresql://postgres.exampleprojectrefbbbb:s3cretPassw0rd@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres';

describe('poolerRegion', () => {
  it('reads the region out of a Supabase pooler host', () => {
    expect(poolerRegion(mumbai)).toBe('ap-south-1');
    expect(poolerRegion(seoul)).toBe('ap-northeast-2');
    expect(poolerRegion(mumbai.replace('aws-0', 'aws-1'))).toBe('ap-south-1');
  });

  it('returns undefined for hosts that do not encode a region (local, direct, junk)', () => {
    expect(poolerRegion('postgres://postgres:postgres@localhost:5433/db')).toBeUndefined();
    expect(poolerRegion('postgresql://u:p@db.abc.supabase.co:5432/postgres')).toBeUndefined();
    expect(poolerRegion('not a url')).toBeUndefined();
  });
});

describe('regionWarnings', () => {
  it('warns when the database is in a different region than the application (the Seoul mistake)', () => {
    const [warning] = regionWarnings(seoul, 'ap-south-1');
    expect(warning).toContain('ap-northeast-2');
    expect(warning).toContain('ap-south-1');
  });

  it('is silent when regions match, or when nothing can be concluded', () => {
    expect(regionWarnings(mumbai, 'ap-south-1')).toEqual([]);
    expect(regionWarnings('postgres://u:p@localhost:5433/db', 'ap-south-1')).toEqual([]);
    expect(regionWarnings(seoul, undefined)).toEqual([]);
  });
});

describe('redact', () => {
  it('removes the password from any message that quotes it', () => {
    const message = 'password authentication failed for s3cretPassw0rd (tried s3cretPassw0rd)';
    expect(redact(message, mumbai)).toBe('password authentication failed for *** (tried ***)');
  });

  it('also removes a percent-encoded password', () => {
    const url = 'postgresql://user:p%40ss%2Fword@host:5432/db';
    expect(redact('bad credentials p@ss/word and p%40ss%2Fword', url)).toBe(
      'bad credentials *** and ***',
    );
  });

  it('leaves messages alone when the URL has no password or cannot be parsed', () => {
    expect(redact('connect ECONNREFUSED', 'postgres://user@host/db')).toBe('connect ECONNREFUSED');
    expect(redact('boom', 'garbage')).toBe('boom');
  });
});

describe('describeEndpoint', () => {
  it('reports host and port, defaulting the port', () => {
    expect(describeEndpoint(mumbai)).toEqual({
      host: 'aws-0-ap-south-1.pooler.supabase.com',
      port: '6543',
    });
    expect(describeEndpoint('postgres://u:p@localhost/db').port).toBe('5432');
    expect(describeEndpoint('nonsense').host).toBe('(unparseable URL)');
  });
});
