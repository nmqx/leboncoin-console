import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.cookie",
      "req.headers.authorization",
      "req.headers[\"x-api-key\"]",
      "datadome",
      "*.datadome",
      "*.luat",
      "password",
      "*.password",
      "apiKey",
      "*.apiKey",
    ],
    censor: "[rédigé]",
  },
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});
