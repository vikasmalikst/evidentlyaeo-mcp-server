import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../services/source-attribution', () => ({
  sourceAttributionService: {
    getSourceAttribution: jest.fn(),
  },
}));

jest.mock('../../middleware/brand-guard', () => ({
  validateBrandOwnership: jest.fn(),
}));

import { sourceAttributionService } from '../../../services/source-attribution';
import { validateBrandOwnership } from '../../middleware/brand-guard';
import { executeSourceAttribution } from '../citations.tool';

const mockGetSourceAttribution = sourceAttributionService.getSourceAttribution as any;
const mockValidateBrandOwnership = validateBrandOwnership as any;

function makeSource(index: number, overrides: Record<string, any> = {}) {
  return {
    name: `source-${index}.com`,
    url: `https://source-${index}.com`,
    type: 'editorial',
    value: index,
    citations: index + 1,
    mentionRate: index * 2,
    soa: index * 3,
    sentiment: Number((index / 10).toFixed(2)),
    visibility: index,
    averagePosition: (index % 10) + 1,
    prompts: [`prompt-${index}`],
    pages: [`https://source-${index}.com/page`],
    ...overrides,
  };
}

describe('executeSourceAttribution (phase hardening)', () => {
  const baseInputs = {
    brandId: '550e8400-e29b-41d4-a716-446655440000',
    startDate: '2026-04-01',
    endDate: '2026-04-10',
  };
  const baseCtx = { customerId: 'customer-1' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateBrandOwnership.mockResolvedValue(undefined);
  });

  it('returns all sources by default and includes metadata counts', async () => {
    const allSources = Array.from({ length: 25 }, (_, i) => makeSource(i + 1));
    mockGetSourceAttribution.mockResolvedValue({
      sources: allSources,
      overallMentionRate: 62.4,
      overallMentionChange: 1.1,
      avgSentiment: 71.2,
      avgSentimentChange: 0.3,
      totalSources: 25,
      dateRange: { start: '2026-04-01T00:00:00.000Z', end: '2026-04-10T23:59:59.999Z' },
    });

    const response: any = await executeSourceAttribution(baseInputs, baseCtx, 'db-token');

    expect(mockValidateBrandOwnership).toHaveBeenCalledWith(
      baseInputs.brandId,
      baseCtx.customerId,
      'db-token'
    );
    expect(response.sources).toHaveLength(25);
    expect(response._meta.total_sources_available).toBe(25);
    expect(response._meta.sources_returned).toBe(25);
    expect(response.summary.total_unique_sources).toBe(25);
    expect(response.summary.overall_mention_rate_pct).toEqual(
      expect.objectContaining({ value: 62.4, unit: 'percent_0_to_100' })
    );
  });

  it('applies topN cap when provided', async () => {
    const allSources = Array.from({ length: 25 }, (_, i) => makeSource(i + 1));
    mockGetSourceAttribution.mockResolvedValue({
      sources: allSources,
      overallMentionRate: 50,
      overallMentionChange: 0,
      avgSentiment: 60,
      avgSentimentChange: 0,
      totalSources: 25,
      dateRange: { start: '2026-04-01T00:00:00.000Z', end: '2026-04-10T23:59:59.999Z' },
    });

    const response: any = await executeSourceAttribution(
      { ...baseInputs, topN: 10 },
      baseCtx,
      'db-token'
    );

    expect(response.sources).toHaveLength(10);
    expect(response._meta.total_sources_available).toBe(25);
    expect(response._meta.sources_returned).toBe(10);
  });

  it('supports fields projection and keeps empty-state annotations', async () => {
    mockGetSourceAttribution.mockResolvedValue({
      sources: [],
      overallMentionRate: 0,
      overallMentionChange: 0,
      avgSentiment: 0,
      avgSentimentChange: 0,
      totalSources: 0,
      dateRange: { start: '2026-04-01T00:00:00.000Z', end: '2026-04-10T23:59:59.999Z' },
    });

    const response: any = await executeSourceAttribution(
      { ...baseInputs, fields: ['sources', '_meta'] },
      baseCtx,
      'db-token'
    );

    expect(response.summary).toBeUndefined();
    expect(response.sources).toEqual(
      expect.objectContaining({
        items: [],
        empty: true,
      })
    );
    expect(response._meta.has_data).toBe(false);
    expect(response._meta.no_data_instruction).toContain('No citation sources found');
  });
});
