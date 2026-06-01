/**
 * Options & GEX Analysis - SQLite Persistence
 *
 * Stores the latest GEX snapshot per symbol (one row each) to warm the
 * in-memory cache on restart. OI-history and unusual-activity tracking were
 * removed; only `gex_snapshots` is used.
 * File: ~/.cache/tradex/options.sqlite3
 */

import path from "node:path";
import { BaseStore, defaultCacheDir } from "../db.js";
import type { GexSnapshot } from "./domain.js";

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

  /**
   * Persist only the latest snapshot for a symbol: delete any prior rows for
   * that symbol, then insert this one. Keeps the table at one row per symbol
   * (no history) so it can warm the in-memory cache on restart.
   */
  replaceLatestSnapshot(snapshot: GexSnapshot): void {
    const conn = this.getConn();
    const tx = conn.transaction(() => {
      conn.prepare(`DELETE FROM gex_snapshots WHERE symbol = ?`).run(snapshot.symbol);
      this.saveGexSnapshot(snapshot);
    });
    tx();
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
