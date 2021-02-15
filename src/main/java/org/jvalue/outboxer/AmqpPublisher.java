package org.jvalue.outboxer;

import io.debezium.config.Configuration;
import io.debezium.embedded.StopConnectorException;
import io.debezium.engine.DebeziumEngine;
import io.debezium.engine.StopEngineException;
import lombok.extern.slf4j.Slf4j;
import org.apache.kafka.connect.source.SourceRecord;
import org.springframework.amqp.AmqpException;
import org.springframework.amqp.core.AmqpTemplate;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageDeliveryMode;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.amqp.rabbit.connection.CachingConnectionFactory;
import org.springframework.amqp.rabbit.core.RabbitTemplate;

import java.io.Closeable;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * This class is a {@link io.debezium.engine.DebeziumEngine.ChangeConsumer} that publishes
 * the events via AMQP. It will get called by the debezium engine to handle the change records.
 *
 * This implementation requires a specific format of the change records, which can be created by
 * the {@link OutboxTableTransform}:
 * <ul>
 *   <li>The record's topic will be the AMQP routing key</li>
 *   <li>The record's key is the unique event id and will be the AMQP message id</li>
 *   <li>The record's value is the event payload and will be the AMQP message body</li>
 * </ul>
 */
@Slf4j
public class AmqpPublisher implements DebeziumEngine.ChangeConsumer<SourceRecord>, Closeable {
  private static final String AMQP_URL_CONFIG_NAME = "amqp.url";
  private static final String AMQP_EXCHANGE_CONFIG_NAME = "amqp.exchange";
  private static final String AMQP_RETRIES_CONFIG_NAME = "amqp.retries";
  private static final String AMQP_RETRY_DELAY_MS_CONFIG_NAME = "amqp.retry.delay.ms";

  private CachingConnectionFactory connectionFactory;
  private AmqpTemplate template;
  private String exchange;
  private int retries;
  private long retryDelayMs;

  public void init(Configuration config) {
    this.exchange = config.getString(AMQP_EXCHANGE_CONFIG_NAME);
    this.retries = config.getInteger(AMQP_RETRIES_CONFIG_NAME);
    this.retryDelayMs = config.getLong(AMQP_RETRY_DELAY_MS_CONFIG_NAME);
    this.connectionFactory = new CachingConnectionFactory(URI.create(config.getString(AMQP_URL_CONFIG_NAME)));
    this.template = new RabbitTemplate(connectionFactory);
  }

  @Override
  public void handleBatch(List<SourceRecord> records, DebeziumEngine.RecordCommitter<SourceRecord> committer) throws InterruptedException {
    for (var record : records) {
      publishEvent(record);
      committer.markProcessed(record);
    }
    committer.markBatchFinished();
  }

  private void publishEvent(SourceRecord record) {
    var routingKey = record.topic();
    var eventId = (String) record.key();
    var payload = (String) record.value();

    log.info("Publishing event {} with routingKey {}", eventId, routingKey);

    var message = createAmqpMessage(eventId, payload);

    // If the message could not be send to amqp, a retry is performed after a delay. If the message could still
    // not be published, it is important that debezium terminates. Otherwise messages can get out of order.
    // Therefore we rethrow the AmqpException, if all retries have been failed. Debezium will catch the exception
    // and terminate. Then the operator is responsible to resolve the issue and restart the outboxer service.
    // Outboxer will then automatically reprocess the failed message, because it has never been marked as processed.
    for (int i = 0; i <= retries; i++) {
      try {
        template.send(exchange, routingKey, message);
        return;
      } catch (RuntimeException e) {
        if (i >= retries) {
          throw e;
        }
        try {
          Thread.sleep(retryDelayMs);
        } catch (InterruptedException ignore) {}
      }
    }
    throw new AmqpException("Could publish event after " + retries + " retries");
  }

  private Message createAmqpMessage(String eventId, String payload) {
    var messageProps = new MessageProperties();
    messageProps.setContentType(MessageProperties.CONTENT_TYPE_JSON);
    messageProps.setContentEncoding(StandardCharsets.UTF_8.name());
    messageProps.setMessageId(eventId);
    // Persist message so it does survive RabbitMQ restarts
    messageProps.setDeliveryMode(MessageDeliveryMode.PERSISTENT);

    return new Message(payload.getBytes(StandardCharsets.UTF_8), messageProps);
  }

  @Override
  public boolean supportsTombstoneEvents() {
    return false;
  }

  @Override
  public void close() throws IOException {
    if (connectionFactory != null) {
      connectionFactory.resetConnection();
    }
  }
}
