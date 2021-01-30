package org.jvalue.outboxer;

import io.debezium.config.Configuration;
import io.debezium.embedded.EmbeddedEngine;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.apache.kafka.connect.errors.ConnectException;

import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

@Slf4j
public class Outboxer {
  private static final String DEFAULT_CONFIG_FILE = "/outboxer.properties";
  private static final String ENV_VAR_PREFIX = "outboxer.";
  private static final String STOP_TIMEOUT_MS_KEY = "stop.timeout.ms";
  private static final String START_RETRY_COUNT_KEY = "start.retry.count";
  private static final String START_RETRY_DELAY_MS_KEY = "start.retry.delay.ms";

  private Configuration config;
  private EmbeddedEngine engine;
  private EmbeddedEngine.CompletionCallback completionCallback;
  private AmqpPublisher amqpPublisher;
  private ExecutorService executorService;

  public void init() {
    config = ConfigHelper.fromResource(DEFAULT_CONFIG_FILE)
      .edit()
      .apply(ConfigHelper.fromEnvVar(ENV_VAR_PREFIX))
      .build();

    executorService = Executors.newSingleThreadExecutor();

    var startRetryCount = config.getInteger(START_RETRY_COUNT_KEY);
    var startRetryDelay = config.getLong(START_RETRY_DELAY_MS_KEY);
    completionCallback = new OutboxerCompletionCallback(startRetryCount, startRetryDelay);

    amqpPublisher = new AmqpPublisher();
    amqpPublisher.init(config.subset("publisher.", true));
  }

  public void start() {
    if (config == null || amqpPublisher == null) {
      throw new IllegalStateException("Outboxer is not initialized.");
    }

    this.engine = new EmbeddedEngine.BuilderImpl()
      .using(config)
      .notifying(amqpPublisher)
      .using(completionCallback)
      .build();

    // Run the engine asynchronously ...
    executorService.execute(engine);
  }

  public void stop() {
    log.info("Stopping the Outboxer");
    if (engine != null) {
      try {
        engine.await(config.getInteger(STOP_TIMEOUT_MS_KEY), TimeUnit.MILLISECONDS);
      } catch (InterruptedException ignore) {}
    }
    // Try to close the amqp connection
    if (amqpPublisher != null) {
      try {
        amqpPublisher.close();
      } catch(IOException ignore) {}
    }
  }

  @RequiredArgsConstructor
  private class OutboxerCompletionCallback implements EmbeddedEngine.CompletionCallback {
    private final int maxRetryCount;
    private final long retryDelayMs;
    private int retryCount = 0;

    @Override
    public void handle(boolean success, String message, Throwable error) {
      if (success) {
        return;
      }
      if (isCreatePostgresConnectionError(error)) {
        if (retry()) {
          return;
        }
      }
      log.error(message, error);
      // Force stop of debezium engine
      System.exit(1);
    }

    private boolean retry() {
      if (retryCount >= maxRetryCount) {
        return false;
      }
      try {
        log.info("Connection to PG failed, retrying in {} ms", retryDelayMs);
        Thread.sleep(retryDelayMs);
        start();
        retryCount++;
        return true;
      } catch (InterruptedException ignore) {}
      return false;
    }

    private boolean isCreatePostgresConnectionError(Throwable error) {
      return error instanceof ConnectException && "Could not create PG connection".equals(error.getMessage());
    }
  }
}
