import type { FastifyInstance } from "fastify";
import type { Bus } from "../bus.js";
import type { Repos } from "../repos.js";
import type { AppConfig } from "../config.js";
import type { SearchEngine } from "../adapters/leboncoin/engine.js";
import type { SchedulerHandle } from "../jobs/scheduler.js";
import type { OutboxHandle } from "../jobs/outbox.js";
import type { SecretVault } from "../security/vault.js";

export interface AppCtx {
  cfg: AppConfig;
  repos: Repos;
  bus: Bus;
  engine: SearchEngine;
  scheduler: SchedulerHandle | null;
  outbox: OutboxHandle | null;
  vault: SecretVault;
  startedAt: number;
  version: string;
  /** Clé LLM si importée (dépiégée une fois, jamais loggée). */
  llmApiKey(): Promise<string | null>;
}

export type RouteModule = (app: FastifyInstance, ctx: AppCtx) => void;
