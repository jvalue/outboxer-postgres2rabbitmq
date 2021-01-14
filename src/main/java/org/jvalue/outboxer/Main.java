package org.jvalue.outboxer;

public class Main {
  public static void main(String[] args) throws Exception {
    var publisher = new Outboxer();
    publisher.init();
    Runtime.getRuntime().addShutdownHook(new Thread(publisher::stop));
    publisher.start();
  }
}
