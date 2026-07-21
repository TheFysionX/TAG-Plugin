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
    const category = typeof options.diagnostic?.category === "string"
      && /^[a-z][a-z0-9_]{0,39}$/.test(options.diagnostic.category)
      ? options.diagnostic.category
      : null;
    const stage = typeof options.diagnostic?.stage === "string"
      && /^[a-z][a-z0-9_]{0,39}$/.test(options.diagnostic.stage)
      ? options.diagnostic.stage
      : null;
    this.diagnostic = category && stage ? Object.freeze({ category, stage }) : null;
  }
}

export function publicError(error) {
  if (error instanceof ConnectorError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.status === null ? {} : { status: error.status }),
      ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
      retryable: error.retryable
    };
  }
  return {
    code: "UNEXPECTED_ERROR",
    message: "The connector hit an unexpected local error. Run doctor for a safe diagnostic summary."
  };
}
