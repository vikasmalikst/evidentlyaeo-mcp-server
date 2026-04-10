import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../services/source-attribution.service', () => ({
  sourceAttributionService: {
    getSourceAttribution: jest.fn(),
  },
}));

jest.mock('../../middleware/brand-guard', () => ({
  validateBrandOwnership: jest.fn(),
}));

import { sourceAttributionService } from '../../../services/source-attribution.service';
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

describe('executeSourceAttribution (MCP citations tool)', () => {
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

  it('returns at most 20 sources, preserves value-desc ranking, and keeps full summary totals', async () => {
    const tieLow = makeSource(999, { name: 'tie-low.com', value: 100, mentionRate: 10 });
    const tieHigh = makeSource(1000, { name: 'tie-high.com', value: 100, mentionRate: 80 });
    const remaining = Array.from({ length: 23 }, (_, i) =>
      makeSource(i + 1, { value: 99 - i, mentionRate: i + 1 })
    );
    const allSources = [tieLow, tieHigh, ...remaining];

    mockGetSourceAttribution.mockResolvedValue({
      sources: allSources,
      overallMentionRate: 62.4,
      overallMentionChange: 1.1,
      avgSentiment: 71.2,
      avgSentimentChange: 0.3,
      totalSources: 25,
      dateRange: { start: '2026-04-01T00:00:00.000Z', end: '2026-04-10T23:59:59.999Z' },
      availableModels: ['Claude', 'ChatGPT'],
    });

    const response: any = await executeSourceAttribution(baseInputs, baseCtx, 'db-token');

    expect(mockValidateBrandOwnership).toHaveBeenCalledWith(
      baseInputs.brandId,
      baseCtx.customerId,
      'db-token'
    );
    expect(response.sources).toHaveLength(20);
    expect(response.summary.total_unique_sources).toBe(25);
    expect(response._meta.limit_applied).toBe(20);
    expect(response._meta.returned_sources).toBe(20);
    expect(response._meta.total_sources_available).toBe(25);
    expect(response._meta.truncated).toBe(true);
    expect(response._meta.ranking).toBe('value_desc');

    const expectedTopNames = [...allSources]
      .sort((a, b) => (b.value ?? Number.NEGATIVE_INFINITY) - (a.value ?? Number.NEGATIVE_INFINITY) || (b.mentionRate ?? 0) - (a.mentionRate ?? 0))
      .slice(0, 20)
      .map((s) => s.name);
    expect(response.sources.map((s: any) => s.name)).toEqual(expectedTopNames);

    const firstSourceKeys = Object.keys(response.sources[0]).sort();
    expect(firstSourceKeys).toEqual(
      [
        'name',
        'url',
        'type',
        'value',
        'citations',
        'mentionRate',
        'soa',
        'sentiment',
        'visibility',
        'averagePosition',
      ].sort()
    );
    expect(response.sources[0]).not.toHaveProperty('prompts');
    expect(response.sources[0]).not.toHaveProperty('pages');
  });

  it('does not truncate when total sources are already <= 20', async () => {
    const allSources = Array.from({ length: 5 }, (_, i) => makeSource(i + 1, { value: 10 - i }));

    mockGetSourceAttribution.mockResolvedValue({
      sources: allSources,
      overallMentionRate: 45.1,
      overallMentionChange: -0.2,
      avgSentiment: 66.9,
      avgSentimentChange: 0,
      totalSources: 5,
      dateRange: { start: '2026-04-01T00:00:00.000Z', end: '2026-04-10T23:59:59.999Z' },
    });

    const response: any = await executeSourceAttribution(baseInputs, baseCtx, 'db-token');

    expect(response.sources).toHaveLength(5);
    expect(response._meta.limit_applied).toBe(20);
    expect(response._meta.returned_sources).toBe(5);
    expect(response._meta.total_sources_available).toBe(5);
    expect(response._meta.truncated).toBe(false);
  });

  it('keeps empty-state behavior when no citation sources are available', async () => {
    mockGetSourceAttribution.mockResolvedValue({
      sources: [],
      overallMentionRate: 0,
      overallMentionChange: 0,
      avgSentiment: 0,
      avgSentimentChange: 0,
      totalSources: 0,
      dateRange: { start: '2026-04-01T00:00:00.000Z', end: '2026-04-10T23:59:59.999Z' },
    });

    const response: any = await executeSourceAttribution(baseInputs, baseCtx, 'db-token');

    expect(response.sources).toEqual([]);
    expect(response.summary).toBeNull();
    expect(response._meta.has_data).toBe(false);
    expect(response._meta.no_data_instruction).toContain('No citation sources found');
    expect(response._meta.limit_applied).toBe(20);
    expect(response._meta.returned_sources).toBe(0);
    expect(response._meta.total_sources_available).toBe(0);
    expect(response._meta.truncated).toBe(false);
  });
});
