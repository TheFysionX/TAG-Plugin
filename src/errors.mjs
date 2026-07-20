export class ConnectorError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ConnectorError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = Boolean(options.retryable);
    this.retryAfterMs = Number.isFinite(options.retryAfterMs)
      ? Math.max(0, Math.floor(options.retryAfterMs))
      : null;
  }
}

export function publicError(error) {
  if (error instanceof ConnectorError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.status === null ? {} : { status: error.status }),
      retryable: error.retryable
    };
  }
  return {
    code: "UNEXPECTED_ERROR",
    message: "The connector hit an unexpected local error. Run doctor for a safe diagnostic summary."
  };
}
