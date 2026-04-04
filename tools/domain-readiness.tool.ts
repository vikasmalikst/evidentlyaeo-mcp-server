import { z } from 'zod';
import { domainReadinessService } from '../../services/domain-readiness/domain-readiness.service';
import { validateBrandOwnership } from '../middleware/brand-guard';
import { McpUserError, McpSystemError } from '../utils/response-formatter';
import { brandIdSchema } from './schemas';

/**
 * Domain Readiness Tool Schema & Handler
 */

export const getDomainAuditSchema = z.object({
  ...brandIdSchema.shape,
});

/**
 * Get the latest AEO Domain Readiness Audit for a specific brand
 */
export async function executeGetDomainAudit(inputs: any, ctx: any, dbToken: string) {
  const { brandId } = inputs;

  await validateBrandOwnership(brandId, ctx.customerId, dbToken);

  try {
    const audit = await domainReadinessService.getLatestAudit(brandId);
    
    if (!audit) {
      return { 
        status: 'no_audit_found', 
        message: 'No domain readiness audit has been performed for this brand yet. Please run an audit via the EvidentlyAEO dashboard.' 
      };
    }

    return { audit };
  } catch (error: any) {
    throw new McpSystemError('Failed to fetch domain readiness audit', error.message);
  }
}
