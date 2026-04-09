import { z } from 'zod';
import { domainReadinessService } from '../../services/domain-readiness/domain-readiness.service';
import { validateBrandOwnership } from '../middleware/brand-guard';
import { McpSystemError } from '../utils/response-formatter';
import { brandIdSchema } from './schemas';

export const getDomainAuditSchema = z.object({
  ...brandIdSchema.shape,
});

export async function executeGetDomainAudit(inputs: any, ctx: any, dbToken: string) {
  const { brandId } = inputs;

  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  try {
    const audit = await domainReadinessService.getLatestAudit(brandId);
    const auditRecord = audit as any;

    if (!audit) {
      return {
        status: 'no_audit_found',
        has_data: false,
        message:
          'No domain readiness audit has been performed for this brand yet. ' +
          'Please run an audit via the EvidentlyAEO dashboard.',
        agent_instruction:
          'Do NOT estimate or guess domain readiness scores. Tell the user exactly this: no audit data is available and they should run an audit from the dashboard.',
      };
    }

    return {
      status: 'audit_found',
      has_data: true,
      _meta: {
        brand_id: brandId,
        data_source: 'EvidentlyAEO domain readiness audit — real crawl-based scores',
        audit_date: auditRecord.created_at ?? auditRecord.updated_at ?? 'unknown',
        usage_note:
          'All scores below are real measured values from the most recent audit crawl. Report exact values only.',
      },
      audit,
    };
  } catch (error: any) {
    throw new McpSystemError('Failed to fetch domain readiness audit', error.message);
  }
}
