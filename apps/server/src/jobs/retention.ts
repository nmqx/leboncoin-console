import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";

/**
 * Rétention : annonces 180 j, messages 90 j, événements/livraisons/logs 30 j.
 * Tourne avec le scheduler à chaque passage.
 */
export function runRetention(db: Db, cfg: AppConfig): void {
  const daysAgoIso = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

  const statements: Array<[string, number]> = [
    ["DELETE FROM listings WHERE last_seen_at < ?", cfg.retentionDays.listings],
    ["DELETE FROM messages WHERE sent_at < ?", cfg.retentionDays.messages],
    ["DELETE FROM events WHERE created_at < ?", cfg.retentionDays.logs],
    ["DELETE FROM webhook_deliveries WHERE created_at < ?", cfg.retentionDays.logs],
    ["DELETE FROM audit_log WHERE created_at < ?", cfg.retentionDays.logs],
    ["DELETE FROM search_jobs WHERE started_at < ?", cfg.retentionDays.logs],
  ];
  let total = 0;
  for (const [sql, days] of statements) {
    const res = db.run(sql, daysAgoIso(days));
    total += Number(res.changes);
  }
  if (total > 0) logger.info({ purgées: total }, "rétention appliquée");
}
