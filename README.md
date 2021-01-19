# outboxer-postgres2rabbitmq

This service allows to implement the [transactional outbox pattern](https://microservices.io/patterns/data/transactional-outbox.html). It reads the changes from an outbox table in a PostgreSQL database using [debezium](https://debezium.io) and publishes the events to RabbitMQ.

## Usage
Outboxer runs inside a docker container. You can build the docker image from the `Dockerfile` located in the root directory.

As a running PostgreSQL and RabbitMQ instance is needed, it is best to use docker-compose. You can find a reference `docker-compose.yml` file in the `integration-test` folder.

## Configuration
Outboxer can either be configured via a `outboxer.properties` file or via environment variables. The following properties are supported:

- `database.hostname` The database host name
- `database.port` The database port
- `database.user` The database username
- `database.password` The database password
- `database.dbname` The database name
- `database.server.name` The unique name that identifies this debezium PostgreSQL connector
- `table.include.list` The name of the outbox table
- `publisher.amqp.url` The url to the AMQP broker
- `publisher.amqp.exchange` The AMQP exchange on which the events should be published.
- `publisher.amqp.retries` How often a failed event publication should be retried
- `publisher.amqp.retry.delay` The delay before performing retry
- `transforms.outbox.table.field.event.id` The name of the column containing the unique event id
- `transforms.outbox.table.field.event.routing_key` The name of the column containing the event routing key
- `transforms.outbox.table.field.event.payload` The name of the column containing the event payload

Note: all properties can also be passed via environment variables, but they must be prefixed with `outboxer.` and can be written in `UPPER_UNDERSCORE` format (e.g. `OUTBOXER_DATABASE_HOSTNAME`).

## Architecture
The outboxer service consists of three main components:
- `Outboxer` This is the main component which clues everything together. It is responsible for configuring, starting and stopping the DebeziumEngine.
- `AmqpPublisher` This a `DebeziumEngine.ChangeConsumer` that gets called by the DebeziumEngine to handle the change records. From each change record it will create an AMQP message and publishes it to the configured AMQP exchange.
- `OutboxTableTransform` This transformation extracts the unique event id, the routing key, and the payload from the raw change records. It does also discard update and delete change records because once an event is published (e.g. added to the outbox table) it should neither be changed nor deleted.
