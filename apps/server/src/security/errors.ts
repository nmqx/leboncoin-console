import { randomUUID } from "node:crypto";

export class AppError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly correlationId: string;
  readonly status: number;

  constructor(code: string, message: string, opts: { status?: number; retryable?: boolean; correlationId?: string } = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status ?? 400;
    this.correlationId = opts.correlationId ?? randomUUID();
  }
}

export const notFound = (what: string) =>
  new AppError("not_found", `${what} introuvable`, { status: 404 });
export const badRequest = (message: string) =>
  new AppError("validation_error", message, { status: 400 });
export const conflict = (message: string) =>
  new AppError("conflict", message, { status: 409 });
export const upstream = (message: string, retryable = true) =>
  new AppError("upstream_error", message, { status: 502, retryable });
export const unavailable = (message: string) =>
  new AppError("unavailable", message, { status: 503, retryable: false });
