# outboxer-postgres2rabbitmq

This service allows to implement the [transactional outbox pattern](https://microservices.io/patterns/data/transactional-outbox.html).
It reads the changes from an outbox table in a PostgreSQL database using [debezium](https://debezium.io) and publishes 
the events to RabbitMQ.

## Usage
Outboxer runs inside a docker container. You can build the docker image from the `Dockerfile` located in the root 
directory.

As a running PostgreSQL and RabbitMQ instance is needed, it is best to use docker-compose. You can find a reference 
`docker-compose.yml` file in the `integration-test` folder.

## Configuration
Outboxer can either be configured via a `outboxer.properties` file or via environment variables. The following 
properties are supported:

- `database.hostname` The database host name
- `database.port` The database port
- `database.user` The database username
- `database.password` The database password
- `database.dbname` The database name
- `database.server.name` The unique name that identifies this debezium PostgreSQL connector
- `table.include.list` The name of the outbox table
- `offset.storage.file.filename` The file where outboxer should store its current offset. The offset is a location in 
  Postgres write-ahead log. Debezium uses this offset to track which records have been processed. After a restart 
  outboxer uses the stored offset as the resume point where to start processing records. If outboxer runs inside a 
  container, this file should be storage outside the container (for example in a docker volume). This ensures that the
  file does survive container restarts.
- `publisher.amqp.url` The url to the AMQP broker
- `publisher.amqp.exchange` The AMQP exchange on which the events should be published.
- `publisher.amqp.retries` How often a failed event publication should be retried
- `publisher.amqp.retry.delay` The delay before performing retry
- `transforms.outbox.table.field.event.id` The name of the column containing the unique event id
- `transforms.outbox.table.field.event.routing_key` The name of the column containing the event routing key
- `transforms.outbox.table.field.event.payload` The name of the column containing the event payload

Note: all properties can also be passed via environment variables, but they must be prefixed with `outboxer.` and can be
written in `UPPER_UNDERSCORE` format (e.g. `OUTBOXER_DATABASE_HOSTNAME`).

## Architecture
The outboxer service consists of three main components:
- `Outboxer` This is the main component which clues everything together. It is responsible for configuring, starting and
  stopping the DebeziumEngine.
- `AmqpPublisher` This a `DebeziumEngine.ChangeConsumer` that gets called by the DebeziumEngine to handle the change 
  records. From each change record it will create an AMQP message and publishes it to the configured AMQP exchange.
- `OutboxTableTransform` This transformation extracts the unique event id, the routing key, and the payload from the raw
  change records. It does also discard update and delete change records because once an event is published (e.g. added 
  to the outbox table) it should neither be changed nor deleted.

## Resilience
Outboxer is very resilience to any kind of failure. The offset in the write-ahead log of the last processed event is 
stored in a file (see `offset.storage.file.filename` property). Outboxer does restore the current offset from this file
after a restart and will only process events that have happened after this offset. Because a new offset can not be
written to disk atomically after the event has been processed, outboxer can only provide at least once delivery for the
events. Therefore, idempotent event consumer should be used, so duplicate events do not cause any issues.

In the following a few common failure scenarios are described in more detail:
- **PostgreSQL becomes unavailable**: If the connection the database is broken, debezium will determine the error kind. 
  If it is a retriable error, debezium will automatically wait some time (configurable with the 
  `retriable.restart.connector.wait.ms` property) before restarting the database connector. If the restart fails, or a
  non retriable error was thrown initially outboxer will terminate. The operator is then responsible to resolve the
  issue and start outboxer again.
- **AMQP broker becomes unavailable**: If the publication of an event is failing, retries are performed as configured
  with the `publisher.amqp.retries` and `publisher.amqp.retry.delay` properties. If all retries are failing, outboxer
  will terminate. Then the operator is responsible to resolve the issue and restart outboxer.
- **Outboxer crashes**: If outboxer is restarted after a crash, it will read the stored offset and will start processing
  events that have happened after the current offset.
