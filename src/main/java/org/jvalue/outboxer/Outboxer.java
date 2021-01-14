package org.jvalue.outboxer;

import io.debezium.config.Configuration;
import io.debezium.embedded.EmbeddedEngine;
import lombok.extern.slf4j.Slf4j;

import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

@Slf4j
public class Outboxer {
  private static final String DEFAULT_CONFIG_FILE = "/outboxer.properties";
  private static final String ENV_VAR_PREFIX = "outboxer.";
  private static final String STOP_TIMEOUT_MS_KEY = "stop.timeout.ms";

  private Configuration config;
  private EmbeddedEngine engine;
  private AmqpPublisher amqpPublisher;

  public void init() {
    config = ConfigHelper.fromResource(DEFAULT_CONFIG_FILE)
      .edit()
      .apply(ConfigHelper.fromEnvVar(ENV_VAR_PREFIX))
      .build();

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
      .build();

    // Run the engine asynchronously ...
    ExecutorService executor = Executors.newSingleThreadExecutor();
    executor.execute(engine);
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
}
