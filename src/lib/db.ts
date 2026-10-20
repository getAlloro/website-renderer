import knex, { Knex } from 'knex';

function buildConfig(): Knex.Config {
  const defaultSchema = process.env.DATABASE_SCHEMA || 'website_builder';
  const environment = process.env.NODE_ENV || 'development';
  const shared = {
    client: 'pg' as const,
    connection: {
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432'),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      // DB_SSL=false turns TLS off for a local, disposable Postgres (the proving runtime); every
      // deployed environment keeps the default.
      ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
    },
    searchPath: [defaultSchema, 'public'],
  };

  const afterCreate = (conn: { query: (sql: string, cb: (err: Error | null) => void) => void }, done: (err: Error | null, conn: unknown) => void) => {
    conn.query(`SET search_path TO "${defaultSchema}", public;`, (err) => {
      done(err, conn);
    });
  };

  const configs: { [key: string]: Knex.Config } = {
    production: {
      ...shared,
      pool: {
        min: 0,
        max: 50,
        acquireTimeoutMillis: 90000,
        createTimeoutMillis: 30000,
        destroyTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
        reapIntervalMillis: 1000,
        createRetryIntervalMillis: 200,
        propagateCreateError: false,
        afterCreate,
      },
      acquireConnectionTimeout: 90000,
    },
    development: {
      ...shared,
      pool: {
        min: 0,
        max: 10,
        acquireTimeoutMillis: 60000,
        createTimeoutMillis: 10000,
        destroyTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
        reapIntervalMillis: 1000,
        createRetryIntervalMillis: 200,
        propagateCreateError: false,
        afterCreate,
      },
      acquireConnectionTimeout: 60000,
    },
  };

  return configs[environment] || configs.development;
}

// Create a singleton instance
let db: Knex | null = null;

export function getDb(): Knex {
  if (!db) {
    db = knex(buildConfig());
  }
  return db;
}

export default getDb;
