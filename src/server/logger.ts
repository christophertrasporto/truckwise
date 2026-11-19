import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    // Contract rate must never reach logs; credentials likewise.
    paths: [
      "password",
      "passwordHash",
      "token",
      "*.password",
      "*.passwordHash",
      "*.token",
      "contract_rate_centavos",
      "contractRateCentavos",
      "*.contract_rate_centavos",
      "*.contractRateCentavos",
    ],
    censor: "[redacted]",
  },
});

export interface LogContext {
  requestId: string;
  tenantId?: string | null;
  userId?: string | null;
}

export function childLogger(ctx: LogContext) {
  return logger.child(ctx);
}
