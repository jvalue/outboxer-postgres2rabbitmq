const fs = require('fs');

const { sleep } = require('@jvalue/node-dry-basics')
const Docker = require('dockerode')

const { AmqpConsumer } = require('./amqp-consumer')
const { DockerCompose } = require('./docker-compose')
const { OutboxDatabase } = require('./outbox-database')

const TEST_TIMEOUT_MS = 300000 // 5 minutes

function getComposeName(container) {
  return container.Labels['com.docker.compose.service']
}

describe('Outboxer', () => {
  let outboxDatabase
  let amqpConsumer
  let docker

  async function waitForContainers(containers = ['database', 'outboxer', 'rabbitmq'], retries = 20, retryDelay = 10000) {
    for (let i = 0; i <= retries; i++) {
      try {
        const runningContainer = (await docker.listContainers()).map(getComposeName).sort()
        expect(runningContainer).toEqual(containers)
      } catch (error) {
        if (i >= retries) {
          throw error
        }
        await sleep(retryDelay)
      }
    }
  }

  async function expectEventDelivery(expectedEvent, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      amqpConsumer.consumeOnce(msg => {
        const eventId = msg.properties.messageId
        const routingKey = msg.fields.routingKey
        const payload = JSON.parse(msg.content.toString())
        expect({ eventId, routingKey, payload }).toEqual(expectedEvent)
        resolve()
      })
      setTimeout(() => reject(new Error(`Timout waiting for event: ${JSON.stringify(expectedEvent)}`)), timeoutMs)
    })
  }

  async function insertEvent(routingKey, payload) {
    const eventId = await outboxDatabase.insertEvent(routingKey, payload)
    return { eventId, routingKey, payload }
  }

  beforeEach(async () => {
    docker = new Docker({})
    await DockerCompose('up -d outboxer')

    outboxDatabase = new OutboxDatabase()
    amqpConsumer = new AmqpConsumer()
    await Promise.allSettled([outboxDatabase.init(), amqpConsumer.init()])
  }, TEST_TIMEOUT_MS)

  afterEach(async () => {
    try {
      const escapedTestName = expect.getState().currentTestName.split(' ').join('_')
      const logs = await DockerCompose('logs --no-color outboxer')
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
    const insertedEvent = await insertEvent('datasource.create', { id: 1, name: 'Test datasource' })
    await expectEventDelivery(insertedEvent)
  }, TEST_TIMEOUT_MS)

  test('does tolerate own restart', async () => {
    const insertedEvent1 = await insertEvent('datasource.create', { id: 1, name: 'Test datasource' })
    await expectEventDelivery(insertedEvent1)

    //Restart outboxer
    await DockerCompose(`stop outboxer`)
    await DockerCompose(`start outboxer`)

    const insertedEvent2 = await insertEvent('datasource.update', { id: 1, name: 'Updated datasource' })
    await expectEventDelivery(insertedEvent2)
  }, TEST_TIMEOUT_MS)

  test('does tolerate database failure with manual restart', async () => {
    const insertedEvent1 = await insertEvent('datasource.create', { id: 1, name: 'Test datasource' })
    await expectEventDelivery(insertedEvent1)

    await DockerCompose(`stop database`)

    // Wait till outboxer has terminated, because all retries are failing
    await waitForContainers(['rabbitmq'])

    await DockerCompose(`start database`)
    await outboxDatabase.waitForConnection()
    await DockerCompose(`start outboxer`)

    const insertedEvent2 = await insertEvent('datasource.update', { id: 1, name: 'Updated datasource' })
    await expectEventDelivery(insertedEvent2)
  }, TEST_TIMEOUT_MS)

  test('does tolerate database failure with retry', async () => {
    const insertedEvent1 = await insertEvent('datasource.create', { id: 1, name: 'Test datasource' })
    await expectEventDelivery(insertedEvent1)

    //Restart database
    await DockerCompose(`stop database`)
    await DockerCompose(`start database`)
    await outboxDatabase.waitForConnection()

    const insertedEvent2 = await insertEvent('datasource.update', { id: 1, name: 'Updated datasource' })
    await expectEventDelivery(insertedEvent2)
  }, TEST_TIMEOUT_MS)

  test('does tolerate RabbitMQ failure with manual restart', async () => {
    const insertedEvent1 = await insertEvent('datasource.create', { id: 1, name: 'Test datasource' })
    await expectEventDelivery(insertedEvent1)

    await amqpConsumer.stop() // close our amqp consumer because we are stopping RabbitMQ
    await DockerCompose('stop rabbitmq')

    // Insert an event, that can not be published because RabbitMQ is down
    const insertedEvent2 = await insertEvent('datasource.update', { id: 1, name: 'Updated datasource'})

    // Wait till outboxer has terminated, because all retries are failing
    await waitForContainers(['database'])

    await DockerCompose('start rabbitmq')
    await amqpConsumer.init()

    await DockerCompose('start outboxer')
    await expectEventDelivery(insertedEvent2)
  }, TEST_TIMEOUT_MS)

  test('does tolerate RabbitMQ failure with retry', async () => {
    const insertedEvent1 = await insertEvent('datasource.create', { id: 1, name: 'Test datasource' })
    await expectEventDelivery(insertedEvent1)

    await amqpConsumer.stop() // close the test's amqp consumer because we are stopping RabbitMQ
    await DockerCompose('stop rabbitmq')

    // Insert an event, that can not be published because RabbitMQ is down
    const insertedEvent2 = await insertEvent('datasource.update', { id: 1, name: 'Updated datasource'})

    await DockerCompose('start rabbitmq')
    await amqpConsumer.init()

    await expectEventDelivery(insertedEvent2)
  }, TEST_TIMEOUT_MS)

  test('publishes two events from one transaction', async () => {
    const eventIds = await outboxDatabase.insertEvents([
      ['entity.create', { id: 42 }],
      ['entity.create', { id: 44 }],
    ])

    await Promise.allSettled([
      expectEventDelivery({ eventId: eventIds[0], routingKey: 'entity.create', payload: { id: 42 } }),
      expectEventDelivery({ eventId: eventIds[1], routingKey: 'entity.create', payload: { id: 44 } })
    ])
  }, TEST_TIMEOUT_MS)
})
