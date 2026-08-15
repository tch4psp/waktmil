'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { AppError, DependencyUnavailableError, RateLimitError } = require('../shared/errors');
const { BoundedRateLimiter } = require('../security/rate-limiter');
const { createMailboxRouter } = require('./routes/mailbox-routes');
const { createAdminRouter } = require('./routes/admin-routes');
const { createEmailIngestRouter } = require('./routes/email-ingest-routes');
const { createMetrics } = require('../observability/metrics');
const { getSystemConfig } = require('../repositories/system-repository');
const { getRuntimeSettings, publicSiteSettings } = require('../services/runtime-settings-service');

function createApp({ config, logger, database, pool, rateLimiter = new BoundedRateLimiter(), metrics = createMetrics() }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.http.trustProxy);
  app.use((request, response, next) => {
    request.requestId = crypto.randomUUID();
    response.setHeader('X-Request-Id', request.requestId);
    next();
  });
  app.use((request, response, next) => {
    const startedAt = process.hrtime.bigint();
    response.on('finish', () => {
      const route = request.route?.path ?? request.baseUrl ?? 'unmatched';
      metrics.recordHttp(request.method, route, response.statusCode, Number(process.hrtime.bigint() - startedAt) / 1e6);
    });
    next();
  });
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        formAction: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"]
      }
    },
    hsts: config.production ? undefined : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false
  }));
  app.use(express.json({ limit: '32kb', type: 'application/json' }));
  app.get('/admin', (_request, response) => response.sendFile(path.join(process.cwd(), 'public', 'admin.html')));
  app.get('/health/live', (_request, response) => response.status(200).json({ status: 'ok' }));
  app.get('/health/ready', async (request, response, next) => {
    try {
      await database.check();
      response.status(200).json({ status: 'ok' });
    } catch (error) {
      next(error instanceof DependencyUnavailableError ? error : new DependencyUnavailableError(undefined, { cause: error }));
    }
  });
  app.get('/api/v1/status', async (_request, response, next) => {
    try {
      await database.check();
      const cleanup = pool ? await getSystemConfig(pool, 'cleanup_health') : null;
      const completedAt = cleanup?.value_json?.completedAt;
      const mailReceiving = completedAt && Date.now() - new Date(completedAt).getTime() <= config.cleanup.intervalSeconds * 3 * 1000 ? 'ok' : 'degraded';
      response.json({ status: mailReceiving === 'ok' ? 'ok' : 'degraded', mailReceiving });
    } catch (error) {
      next(error instanceof DependencyUnavailableError ? error : new DependencyUnavailableError(undefined, { cause: error }));
    }
  });
  if (pool) {
    app.get('/api/v1/site', async (_request, response, next) => {
      try { response.json({ site: publicSiteSettings(await getRuntimeSettings({ pool, config })) }); } catch (error) { next(error); }
    });
    app.use(async (request, response, next) => {
      if (request.path.startsWith('/admin') || request.path.startsWith('/api/v1/admin') || request.path.startsWith('/internal/email-ingest') || request.path.startsWith('/health') || request.path === '/api/v1/site') return next();
      if (path.extname(request.path)) return next();
      try {
        const settings = await getRuntimeSettings({ pool, config });
        if (!settings.site.maintenanceMode) return next();
        if (request.path.startsWith('/api/')) return response.status(503).json({ error: { code: 'MAINTENANCE', message: 'Service is temporarily unavailable.', requestId: request.requestId } });
        return response.status(503).sendFile(path.join(process.cwd(), 'public', 'maintenance.html'));
      } catch (error) { next(error); }
    });
    app.use('/internal/email-ingest', createEmailIngestRouter({ pool, config }));
    app.use('/api/v1/admin', createAdminRouter({ pool, config, rateLimiter }));
    app.use('/api/v1', createMailboxRouter({ pool, config, rateLimiter }));
  }
  app.use(express.static(path.join(process.cwd(), 'public'), { index: 'index.html' }));
  app.use((request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: request.requestId } });
  });
  app.use((error, request, response, _next) => {
    const appError = error instanceof AppError
      ? error
      : error?.type === 'entity.too.large'
        ? new AppError('PAYLOAD_TOO_LARGE', 'Request payload is too large.', 413)
        : new AppError('INTERNAL_ERROR', 'Internal server error.', 500, { expose: false, cause: error });
    if (appError instanceof RateLimitError) response.setHeader('Retry-After', String(appError.retryAfterSeconds));
    logger.error({ event: 'request_error', requestId: request.requestId, errorCode: appError.code, err: error }, 'Request failed');
    response.status(appError.statusCode).json({
      error: {
        code: appError.code,
        message: appError.expose ? appError.message : 'Internal server error.',
        requestId: request.requestId
      }
    });
  });
  app.locals.metrics = metrics;
  return app;
}

module.exports = { createApp };
