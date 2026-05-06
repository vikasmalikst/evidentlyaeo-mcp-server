/**
 * This file provides type definitions for modules that are part of the private
 * EvidentlyAEO backend but are not included in this public MCP repository.
 * 
 * This allows the code to be reviewed and compiled for validation without
 * exposing proprietary business logic services.
 */

declare module '../../services/*' {
  const content: any;
  export default content;
  export const brandService: any;
  export const dashboardService: any;
  export const queryAggregationService: any;
  export const sourceAttributionService: any;
  export const citationAggregationService: any;
  export const domainReadinessService: any;
  export const authService: any;
  export const validateApiKey: any;
}

declare module '../../utils/*' {
  const content: any;
  export default content;
  export const verifyToken: any;
  export const logger: any;
}

declare module '../../services/brand-dashboard/types' {
  export type BrandRow = any;
}

// Add any other missing imports here
