'use strict';

class AppError extends Error {
  constructor(code, message, statusCode, options = {}) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.expose = options.expose ?? true;
  }
}

class ValidationError extends AppError {
  constructor(message = 'Invalid request.') {
    super('VALIDATION_ERROR', message, 400);
  }
}

class DependencyUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable.', options = {}) {
    super('DEPENDENCY_UNAVAILABLE', message, 503, options);
  }
}

class UnauthorizedError extends AppError {
  constructor() {
    super('UNAUTHORIZED', 'Unauthorized.', 401);
  }
}

class ExpiredError extends AppError {
  constructor() {
    super('MAILBOX_EXPIRED', 'This mailbox has expired.', 410);
  }
}

class NotFoundError extends AppError {
  constructor() {
    super('NOT_FOUND', 'Not found.', 404);
  }
}

class RateLimitError extends AppError {
  constructor(retryAfterSeconds) {
    super('RATE_LIMITED', 'Too many requests.', 429);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class PolicyRejectedError extends AppError {
  constructor(message = 'Message rejected by policy.') {
    super('POLICY_REJECTED', message, 422);
  }
}

class AttachmentUnavailableError extends AppError {
  constructor() {
    super('ATTACHMENT_UNAVAILABLE', 'Attachment is not available.', 423);
  }
}

module.exports = { AppError, ValidationError, DependencyUnavailableError, UnauthorizedError, ExpiredError, NotFoundError, RateLimitError, PolicyRejectedError, AttachmentUnavailableError };
