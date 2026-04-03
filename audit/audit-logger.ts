import crypto from 'crypto';
import { supabaseAdmin } from '../../config/database';

export interface AuditLogEntry {
  userId: string;
  customerId: string;
  toolName: string;
  inputs: Record<string, unknown>;
  scopeUsed: string;
  outcome: 'success' | 'user_error' | 'system_error';
  errorCode?: string;
  durationMs: number;
  cacheHit?: boolean;
}

/**
 * Creates a deterministic SHA-256 hash of the inputs.
 */
function hashInputs(inputs: Record<string, unknown>): string {
  const normalized = Object.keys(inputs)
    .sort()
    .map(key => `${key}=${JSON.stringify(inputs[key])}`)
    .join('|');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Creates a sanitized summary of inputs (e.g. key names and structural info)
 * without leaking raw values (to keep logs secure).
 */
function summarizeInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = { keys: Object.keys(inputs) };
  if (inputs.brandId && typeof inputs.brandId === 'string') {
    summary.brandIdPrefix = inputs.brandId.substring(0, 8) + '...';
  }
  if (inputs.startDate) summary.hasStartDate = true;
  if (inputs.endDate) summary.hasEndDate = true;
  if (inputs.topic) summary.hasTopic = true;
  return summary;
}

/**
 * Logs MCP tool executions to Supabase asynchronously (fire-and-forget).
 */
export function logAudit(entry: AuditLogEntry): void {
  const inputsHash = hashInputs(entry.inputs);
  const inputsSummary = summarizeInputs(entry.inputs);

  // Fire and forget
  supabaseAdmin
    .from('mcp_audit_logs')
    .insert({
      user_id: entry.userId,
      customer_id: entry.customerId,
      tool_name: entry.toolName,
      inputs_hash: inputsHash,
      inputs_summary: inputsSummary,
      scope_used: entry.scopeUsed,
      outcome: entry.outcome,
      error_code: entry.errorCode || null,
      duration_ms: entry.durationMs,
      cache_hit: entry.cacheHit || false,
    })
    .then(({ error }) => {
      if (error) {
        console.error('[MCP Audit Logger] Failed to insert log:', error.message);
      }
    });
}
