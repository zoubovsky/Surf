import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(level: string = process.env["LOG_LEVEL"] ?? "info", name = "surf"): Logger {
  return pino({ level, name, base: null, timestamp: pino.stdTimeFunctions.isoTime });
}
