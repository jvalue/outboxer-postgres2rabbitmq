const { PostgresClient } = require('@jvalue/node-dry-pg')

const { POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USERNAME, POSTGRES_PASSWORD, POSTGRES_DATABASE, OUTBOX_TABLE_NAME,
  POSTGRES_CONNECTION_RETRIES, POSTGRES_CONNECTION_RETRY_DELAY } = require('./env')

const POOL_CONFIG = {
  host: POSTGRES_HOST,
  port: POSTGRES_PORT,
  user: POSTGRES_USERNAME,
  password: POSTGRES_PASSWORD,
  database: POSTGRES_DATABASE,
}

const CREATE_OUTBOX_TABLE_SQL = `
CREATE TABLE "${OUTBOX_TABLE_NAME}"(
  id uuid not null constraint outbox_pk primary key default gen_random_uuid(),
  routing_key varchar(255) not null,
  payload jsonb
);
`

const INSERT_INTO_OUTBOX_TABLE_SQL = `
INSERT INTO "${OUTBOX_TABLE_NAME}"
  ("routing_key", "payload")
  VALUES ($1, $2)
  RETURNING id
`

class OutboxDatabase {
  constructor() {
    this.client = new PostgresClient(POOL_CONFIG)
  }

  async init() {
    await this.client.waitForConnection(POSTGRES_CONNECTION_RETRIES, POSTGRES_CONNECTION_RETRY_DELAY)
    await this.client.executeQuery(CREATE_OUTBOX_TABLE_SQL)
  }

  async waitForConnection() {
    await this.client.waitForConnection(POSTGRES_CONNECTION_RETRIES, POSTGRES_CONNECTION_RETRY_DELAY)
  }

  async insertEvent(routingKey, payload) {
    const { rows } = await this.client.executeQuery(INSERT_INTO_OUTBOX_TABLE_SQL, [routingKey, payload])
    return rows[0].id;
  }

  async insertEvents(events) {
    return await this.client.transaction(async client => {
      const eventIds = []
      for (let i = 0; i < events.length; i++) {
        const { rows } = await client.query(INSERT_INTO_OUTBOX_TABLE_SQL, events[i])
        eventIds.push(rows[0].id);
      }
      return eventIds
    })
  }

  async close() {
    await this.client.close()
  }
}

module.exports = {
  OutboxDatabase
}
