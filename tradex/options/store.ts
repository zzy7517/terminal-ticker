/**
 * Options & GEX Analysis - SQLite Persistence
 *
 * Stores GEX snapshots, OI history, and unusual activity records.
 * File: ~/.cache/tradex/options.sqlite3
 */

import path from "node:path";
import { BaseStore, defaultCacheDir } from "../db.js";
import type { GexSnapshot, OiRecord, UnusualActivity } from "./domain.js";

const DEFAULT_FILENAME = "options.sqlite3";

export class OptionsStore extends BaseStore {
  constructor(dbPath?: string) {
    super(dbPath ?? path.join(defaultCacheDir(), DEFAULT_FILENAME));
  }

  protected override initSchema(conn: import("better-sqlite3").Database): void {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS gex_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        spot_price REAL NOT NULL,
        net_gex REAL NOT NULL,
        total_call_gex REAL NOT NULL,
        total_put_gex REAL NOT NULL,
        zero_gamma_level REAL NOT NULL,
        regime TEXT NOT NULL,
        call_wall REAL,
        put_wall REAL,
        max_gamma_strike REAL,
        charm_flow REAL,
        vanna_flow REAL,
        provider TEXT NOT NULL,
        gex_by_strike_json TEXT,
        UNIQUE(symbol, timestamp_ms, provider)
      );
      CREATE INDEX IF NOT EXISTS idx_gex_symbol_time ON gex_snapshots(symbol, timestamp_ms DESC);

      CREATE TABLE IF NOT EXISTS oi_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        strike REAL NOT NULL,
        option_type TEXT NOT NULL,
        expiration TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        open_interest INTEGER NOT NULL,
        volume INTEGER NOT NULL,
        implied_vol REAL,
        UNIQUE(symbol, strike, option_type, expiration, timestamp_ms)
      );
      CREATE INDEX IF NOT EXISTS idx_oi_symbol_strike ON oi_history(symbol, strike, timestamp_ms DESC);

      CREATE TABLE IF NOT EXISTS unusual_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        strike REAL NOT NULL,
        option_type TEXT NOT NULL,
        expiration TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        oi_change INTEGER NOT NULL,
        volume INTEGER NOT NULL,
        volume_oi_ratio REAL,
        premium_estimate REAL,
        signal TEXT,
        UNIQUE(symbol, strike, option_type, expiration, timestamp_ms)
      );
      CREATE INDEX IF NOT EXISTS idx_unusual_time ON unusual_activity(timestamp_ms DESC);
    `);
  }

  // --------------------------------------------------------------------------
  // GEX Snapshots
  // --------------------------------------------------------------------------

  saveGexSnapshot(snapshot: GexSnapshot): void {
    const conn = this.getConn();
    const stmt = conn.prepare(`
      INSERT OR REPLACE INTO gex_snapshots
        (symbol, timestamp_ms, spot_price, net_gex, total_call_gex, total_put_gex,
         zero_gamma_level, regime, call_wall, put_wall, max_gamma_strike,
         charm_flow, vanna_flow, provider, gex_by_strike_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      snapshot.symbol,
      snapshot.timestamp,
      snapshot.spotPrice,
      snapshot.netGex,
      snapshot.totalCallGex,
      snapshot.totalPutGex,
      snapshot.zeroGammaLevel,
      snapshot.regime,
      snapshot.keyLevels.callWall,
      snapshot.keyLevels.putWall,
      snapshot.keyLevels.maxGammaStrike,
      snapshot.charmVanna?.charmFlow ?? null,
      snapshot.charmVanna?.vannaFlow ?? null,
      snapshot.provider,
      JSON.stringify(snapshot.gexByStrike),
    );
  }

  getRecentSnapshots(symbol: string, limit = 100): GexSnapshot[] {
    const conn = this.getConn();
    const rows = conn.prepare(`
      SELECT * FROM gex_snapshots
      WHERE symbol = ?
      ORDER BY timestamp_ms DESC
      LIMIT ?
    `).all(symbol, limit) as any[];

    return rows.map(row => this.rowToSnapshot(row)).reverse();
  }

  getLatestSnapshot(symbol: string): GexSnapshot | null {
    const conn = this.getConn();
    const row = conn.prepare(`
      SELECT * FROM gex_snapshots
      WHERE symbol = ?
      ORDER BY timestamp_ms DESC
      LIMIT 1
    `).get(symbol) as any;

    return row ? this.rowToSnapshot(row) : null;
  }

  // --------------------------------------------------------------------------
  // OI History
  // --------------------------------------------------------------------------

  saveOiRecords(records: OiRecord[]): void {
    if (records.length === 0) return;
    const conn = this.getConn();
    const stmt = conn.prepare(`
      INSERT OR REPLACE INTO oi_history
        (symbol, strike, option_type, expiration, timestamp_ms, open_interest, volume, implied_vol)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = conn.transaction(() => {
      for (const r of records) {
        stmt.run(r.symbol, r.strike, r.type, r.expiration, r.timestampMs, r.openInterest, r.volume, r.impliedVol);
      }
    });
    tx();
  }

  getPreviousOi(symbol: string, strike: number, type: string, expiration: string): number | null {
    const conn = this.getConn();
    const row = conn.prepare(`
      SELECT open_interest FROM oi_history
      WHERE symbol = ? AND strike = ? AND option_type = ? AND expiration = ?
      ORDER BY timestamp_ms DESC
      LIMIT 1 OFFSET 1
    `).get(symbol, strike, type, expiration) as any;

    return row?.open_interest ?? null;
  }

  // --------------------------------------------------------------------------
  // Unusual Activity
  // --------------------------------------------------------------------------

  saveUnusualActivity(items: UnusualActivity[]): void {
    if (items.length === 0) return;
    const conn = this.getConn();
    const stmt = conn.prepare(`
      INSERT OR IGNORE INTO unusual_activity
        (symbol, strike, option_type, expiration, timestamp_ms, oi_change, volume, volume_oi_ratio, premium_estimate, signal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = conn.transaction(() => {
      for (const item of items) {
        stmt.run(
          item.symbol, item.strike, item.type, item.expiration,
          item.timestampMs, item.oiChange, item.volume,
          item.volumeOiRatio, item.premiumEstimate, item.signal,
        );
      }
    });
    tx();
  }

  getRecentUnusualActivity(symbol: string | null, limit = 50): UnusualActivity[] {
    const conn = this.getConn();
    let query = `SELECT * FROM unusual_activity`;
    const params: any[] = [];

    if (symbol) {
      query += ` WHERE symbol = ?`;
      params.push(symbol);
    }
    query += ` ORDER BY timestamp_ms DESC LIMIT ?`;
    params.push(limit);

    const rows = conn.prepare(query).all(...params) as any[];
    return rows.map(row => ({
      symbol: row.symbol,
      strike: row.strike,
      type: row.option_type as "call" | "put",
      expiration: row.expiration,
      timestampMs: row.timestamp_ms,
      oiChange: row.oi_change,
      volume: row.volume,
      volumeOiRatio: row.volume_oi_ratio,
      premiumEstimate: row.premium_estimate,
      signal: row.signal,
    }));
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  /** Remove records older than the specified retention periods */
  cleanup(gexDays = 30, oiDays = 7, unusualDays = 90): void {
    const conn = this.getConn();
    const now = Date.now();

    conn.prepare(`DELETE FROM gex_snapshots WHERE timestamp_ms < ?`).run(now - gexDays * 86_400_000);
    conn.prepare(`DELETE FROM oi_history WHERE timestamp_ms < ?`).run(now - oiDays * 86_400_000);
    conn.prepare(`DELETE FROM unusual_activity WHERE timestamp_ms < ?`).run(now - unusualDays * 86_400_000);
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private rowToSnapshot(row: any): GexSnapshot {
    const gexByStrike = row.gex_by_strike_json ? JSON.parse(row.gex_by_strike_json) : [];
    return {
      timestamp: row.timestamp_ms,
      symbol: row.symbol,
      spotPrice: row.spot_price,
      netGex: row.net_gex,
      netGexBillions: row.net_gex / 1e9,
      totalCallGex: row.total_call_gex,
      totalPutGex: row.total_put_gex,
      zeroGammaLevel: row.zero_gamma_level,
      regime: row.regime,
      regimeDescription: "",
      dominantStrike: row.max_gamma_strike ?? row.spot_price,
      keyLevels: {
        callWall: row.call_wall ?? row.spot_price,
        putWall: row.put_wall ?? row.spot_price,
        maxGammaStrike: row.max_gamma_strike ?? row.spot_price,
        zeroGammaLevel: row.zero_gamma_level,
        zglCrossingFound: true,
      },
      gexByStrike,
      charmVanna: row.charm_flow != null ? {
        charmFlow: row.charm_flow,
        vannaFlow: row.vanna_flow ?? 0,
        netHiddenFlow: (row.charm_flow ?? 0) + (row.vanna_flow ?? 0),
        charmByStrike: {},
        vannaByStrike: {},
      } : null,
      provider: row.provider,
      // Advanced analytics are live-only; not persisted in history rows.
      regimeParams: null,
      ivSurface: null,
      hedgeImpulse: null,
      pressureCloud: null,
      exposure: null,
    };
  }
}
