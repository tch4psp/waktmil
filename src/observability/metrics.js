'use strict';

const http = require('node:http');

function createMetrics() {
  const requests = new Map();
  return {
    recordHttp(method, route, statusCode, durationMs) {
      const key = `${method}|${route}|${statusCode}`;
      const current = requests.get(key) ?? { count: 0, durationMs: 0 };
      current.count += 1;
      current.durationMs += durationMs;
      requests.set(key, current);
    },
    render() {
      const lines = ['# HELP tempmail_http_requests_total HTTP requests handled.', '# TYPE tempmail_http_requests_total counter', '# HELP tempmail_http_request_duration_seconds_total Aggregate HTTP request duration.', '# TYPE tempmail_http_request_duration_seconds_total counter'];
      for (const [key, value] of requests) {
        const [method, route, status] = key.split('|');
        const labels = `method="${method}",route="${route}",status="${status}"`;
        lines.push(`tempmail_http_requests_total{${labels}} ${value.count}`);
        lines.push(`tempmail_http_request_duration_seconds_total{${labels}} ${(value.durationMs / 1000).toFixed(6)}`);
      }
      return `${lines.join('\n')}\n`;
    }
  };
}

function startMetricsServer(config, metrics, logger) {
  if (!config.metrics.enabled) return null;
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/metrics') { response.statusCode = 404; response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(metrics.render());
  });
  server.listen(config.metrics.port, config.metrics.host, () => logger.info({ event: 'metrics_started', host: config.metrics.host, port: config.metrics.port }, 'Metrics server started'));
  return server;
}

module.exports = { createMetrics, startMetricsServer };
