const fs = require('fs');

const { sleep } = require('@jvalue/node-dry-basics')

const { AmqpConsumer } = require('./amqp-consumer')
const { DockerCompose } = require('./docker-compose')
const { OutboxDatabase } = require('./outbox-database')

const TEST_TIMEOUT_MS = 120000 // 2 minutes
const STARTUP_WAIT_TIME_MS = 1000
const PUBLICATION_WAIT_TIME_MS = 5000
const OUTBOXER_RESTART_WAIT_TIME_MS = 5000
const RABBITMQ_RESTART_WAIT_TIME_MS = 5000
// debezium connector has a retry delay of 10 seconds (see retriable.restart.connector.wait.ms property).
// We use 20 seconds to be save that debezium connector has successfully reconnected
const DATABASE_RESTART_WAIT_TIME_MS = 20000

describe('Outboxer', () => {
  let outboxDatabase
  let amqpConsumer
  let receivedEvents
  let insertedEvents

  async function initAmqpConsumer() {
    const amqpConsumer = new AmqpConsumer()
    await amqpConsumer.init(msg => {
      const eventId = msg.properties.messageId
      const routingKey = msg.fields.routingKey
      const payload = JSON.parse(msg.content.toString())
      receivedEvents.push({ eventId, routingKey, payload })
    })
    return amqpConsumer
  }

  async function insertEvent(routingKey, payload) {
    const eventId = await outboxDatabase.insertEvent(routingKey, payload)
    insertedEvents.push({ eventId, routingKey, payload })
  }

  beforeEach(async () => {
    await DockerCompose('up -d rabbitmq database')
    await sleep(STARTUP_WAIT_TIME_MS)
    await DockerCompose('up -d outboxer')
    await sleep(STARTUP_WAIT_TIME_MS)

    outboxDatabase = new OutboxDatabase()
    await outboxDatabase.init()

    receivedEvents = []
    insertedEvents = []
    amqpConsumer = await initAmqpConsumer()
  }, TEST_TIMEOUT_MS)

  afterEach(async () => {
    try {
      const escapedTestName = expect.getState().currentTestName.split(' ').join('_')
      const logs = await DockerCompose('logs --no-color')
      if (!fs.existsSync('logs')) {
        fs.mkdirSync('logs')
      }
      fs.writeFileSync(`logs/${escapedTestName}.log`, logs.stdout)

      if (outboxDatabase) {
        await outboxDatabase.close()
      }

      if (amqpConsumer) {
        await amqpConsumer.stop()
      }
    } catch (error) {
      console.log('Cleanup failed', error)
    }

    await DockerCompose('down')
  }, TEST_TIMEOUT_MS)

  test('publishes event from outbox', async () => {
    await insertEvent('datasource.create', { id: 1, name: 'Test datasource' })
    await sleep(PUBLICATION_WAIT_TIME_MS)
    expect(receivedEvents).toEqual(insertedEvents)
  }, TEST_TIMEOUT_MS)

  test('does tolerate own restart', async () => {
    await insertEvent('datasource.create', { id: 1, name: 'Test datasource' })
    await sleep(PUBLICATION_WAIT_TIME_MS)
    expect(receivedEvents).toEqual(insertedEvents)

    //Restart outboxer
    await DockerCompose(`stop outboxer`)
    await DockerCompose(`start outboxer`)
    await sleep(OUTBOXER_RESTART_WAIT_TIME_MS)

    await insertEvent('datasource.update', { id: 1, name: 'Updated datasource' })
    await sleep(PUBLICATION_WAIT_TIME_MS)
    expect(receivedEvents).toEqual(insertedEvents)
  }, TEST_TIMEOUT_MS)

  test('does tolerate database restart', async () => {
    await insertEvent('datasource.create', { id: 1, name: 'Test datasource' })
    await sleep(PUBLICATION_WAIT_TIME_MS)
    expect(receivedEvents).toEqual(insertedEvents)

    //Restart database
    await DockerCompose(`stop database`)
    await DockerCompose(`start database`)
    await sleep(DATABASE_RESTART_WAIT_TIME_MS)

    await insertEvent('datasource.update', { id: 1, name: 'Updated datasource' })
    await sleep(PUBLICATION_WAIT_TIME_MS)
    expect(receivedEvents).toEqual(insertedEvents)
  }, TEST_TIMEOUT_MS)

  test('does tolerate RabbitMQ failure with manual restart', async () => {
    await insertEvent('datasource.create', { id: 1, name: 'Test datasource' })
    await sleep(PUBLICATION_WAIT_TIME_MS)
    expect(receivedEvents).toEqual(insertedEvents)

    await amqpConsumer.stop() // close our amqp consumer because we are stopping RabbitMQ

    await DockerCompose('stop rabbitmq')

    // Insert an event, that can not be published because RabbitMQ is down
    await insertEvent('datasource.update', { id: 1, name: 'Updated datasource'})

    // Wait before restarting RabbitMQ so all retries of outboxer are failing.
    // Outboxer makes 5 retries with a delay of 5 seconds so we wait 30 seconds to be save
    await sleep(30000)

    await DockerCompose('start rabbitmq')
    await sleep(RABBITMQ_RESTART_WAIT_TIME_MS)

    amqpConsumer = await initAmqpConsumer()

    await DockerCompose('start outboxer')
    await sleep(OUTBOXER_RESTART_WAIT_TIME_MS)

    expect(receivedEvents).toEqual(insertedEvents)
  }, TEST_TIMEOUT_MS)

  test('does tolerate RabbitMQ failure with retry', async () => {
    await insertEvent('datasource.create', { id: 1, name: 'Test datasource' })
    await sleep(PUBLICATION_WAIT_TIME_MS)
    expect(receivedEvents).toEqual(insertedEvents)

    await amqpConsumer.stop() // close the test's amqp consumer because we are stopping RabbitMQ

    await DockerCompose('stop rabbitmq')

    // Insert an event, that can not be published because RabbitMQ is down
    await insertEvent('datasource.update', { id: 1, name: 'Updated datasource'})

    await DockerCompose('start rabbitmq')
    await sleep(RABBITMQ_RESTART_WAIT_TIME_MS)

    // Start the test's amqpConsumer and wait so it has time to consume all pending events
    amqpConsumer = await initAmqpConsumer()
    await sleep(PUBLICATION_WAIT_TIME_MS)

    expect(receivedEvents).toEqual(insertedEvents)
  }, TEST_TIMEOUT_MS)

  test('publishes two events from one transaction', async () => {
    const eventIds = await outboxDatabase.insertEvents([
      ['entity.create', { id: 42 }],
      ['entity.create', { id: 44 }],
    ])

    await sleep(PUBLICATION_WAIT_TIME_MS)

    expect(receivedEvents).toEqual([
      { eventId: eventIds[0], routingKey: 'entity.create', payload: { id: 42 } },
      { eventId: eventIds[1], routingKey: 'entity.create', payload: { id: 44 } },
    ])
  }, TEST_TIMEOUT_MS)
})
