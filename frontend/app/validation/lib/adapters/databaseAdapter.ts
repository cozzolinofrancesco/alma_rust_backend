import type { Claim, RetrievalResult } from '@/app/claim-validation/types';
import { getConnection } from '@/app/lib/sources/dbConnectionStore';
import { getDriver } from '@/app/lib/sources/drivers';
import type { DbConnectionInput } from '@/app/lib/sources/dbConnection';
import { buildRetrieval, type AdapterContext, type ReferenceAdapter } from '../referenceAdapter';
import { generateSelect, type TableSchema } from '../nlToSql';

// doc-db: only NUMERICAL/STATISTICAL claims are reconciled. prepare() resolves
// the owner's stored connection and samples the schema (table + column names) so
// NL→SQL is constrained to real names; getEvidence() generates a read-only
// SELECT, runs it via the driver (guarded + row-capped), and returns the rows
// as evidence for the reconciliation judge.
const MAX_TABLES = 12;
const RECONCILABLE: ReadonlySet<string> = new Set(['NUMERICAL', 'STATISTICAL']);

export function createDatabaseAdapter(): ReferenceAdapter {
  let config: DbConnectionInput | null = null;
  let schema: TableSchema[] = [];

  return {
    mode: 'doc-db',
    label: 'Document vs database',
    async prepare(ctx: AdapterContext): Promise<void> {
      if (!ctx.dbConnectionId) throw new Error('No database connection selected.');
      const conn = getConnection(ctx.dbConnectionId, ctx.ownerEmail);
      if (!conn) throw new Error('Database connection not found.');
      config = conn.config;
      const driver = getDriver(config.type);
      const tables = (await driver.listTables(config)).slice(0, MAX_TABLES);
      schema = [];
      for (const table of tables) {
        try {
          const preview = await driver.previewTable(config, table);
          schema.push({ table, columns: preview.columns });
        } catch {
          schema.push({ table, columns: [] });
        }
      }
    },
    async getEvidence(claim: Claim): Promise<RetrievalResult> {
      if (!config || !RECONCILABLE.has(String(claim.claim_type).toUpperCase())) {
        return buildRetrieval(claim.claim_id, 'database', []);
      }
      const sql = await generateSelect(claim, schema);
      if (!sql) return buildRetrieval(claim.claim_id, 'database', []);

      const result = await getDriver(config.type).runSelect(config, sql);
      const rowsText = result.rows
        .slice(0, 20)
        .map((r) => JSON.stringify(r))
        .join('\n');
      const content = `Generated query:\n${sql}\n\nResult (${result.rowCount} rows${result.truncated ? ', capped' : ''}):\n${rowsText || '(no rows)'}`;
      return buildRetrieval(claim.claim_id, 'database', [{ content, source_ref: sql }]);
    },
  };
}
