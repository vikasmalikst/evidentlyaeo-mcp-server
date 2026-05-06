import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../services/mcp-aggregations/query-aggregation.service', () => ({
  queryAggregationService: {
    getQueriesSummary: jest.fn(),
    getTopicsSummary: jest.fn(),
    getQueryDetail: jest.fn(),
  },
}));

jest.mock('../../middleware/brand-guard', () => ({
  validateBrandOwnership: jest.fn(),
}));

import { queryAggregationService } from '../../../services/mcp-aggregations/query-aggregation.service';
import { validateBrandOwnership } from '../../middleware/brand-guard';
import {
  executeQueriesSummary,
  executeTopicsPerformance,
  executeQueriesCollectorBreakdown,
} from '../queries.tool';

const mockService = queryAggregationService as any;
const mockValidateBrandOwnership = validateBrandOwnership as any;

describe('queries.tool competitor defaults and meta states', () => {
  const baseCtx = { customerId: 'customer-1' };
  const baseInputs = {
    brandId: '550e8400-e29b-41d4-a716-446655440000',
    startDate: '2026-03-01',
    endDate: '2026-04-24',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateBrandOwnership.mockResolvedValue(undefined);
  });

  it('queries_summary defaults includeCompetitors to true and reports included_with_rows', async () => {
    mockService.getQueriesSummary.mockResolvedValue([
      {
        query_text: 'magnet vs howdens kitchens?',
        query_type: 'blind',
        visibility_score: 61.2,
        share_of_answer_score: 93.3,
        sentiment_score: 70.1,
        sentiment_label: 'positive',
        mentions: 12,
        brand_presence_pct: 100,
        topic: 'Awareness & Informational',
        competitors: [
          { name: 'Howdens', visibility_score: 58.4, soa_score: 81.2, mentions: 9 },
        ],
      },
    ]);

    const response: any = await executeQueriesSummary(baseInputs, baseCtx, 'db-token');

    expect(mockService.getQueriesSummary).toHaveBeenCalledWith(
      expect.objectContaining({ includeCompetitors: true })
    );
    expect(response.queries[0].competitors).toHaveLength(1);
    expect(response._meta.include_competitors_effective).toBe(true);
    expect(response._meta.competitor_data_state).toBe('included_with_rows');
  });

  it('queries_summary honors explicit includeCompetitors=false and reports explicitly_excluded', async () => {
    mockService.getQueriesSummary.mockResolvedValue([
      {
        query_text: 'query',
        query_type: 'blind',
        visibility_score: 40,
        share_of_answer_score: 50,
        sentiment_score: null,
        sentiment_label: null,
        mentions: 2,
        brand_presence_pct: 30,
        topic: 'General',
        competitors: [{ name: 'Howdens', visibility_score: 50, soa_score: 40, mentions: 1 }],
      },
    ]);

    const response: any = await executeQueriesSummary(
      { ...baseInputs, includeCompetitors: false },
      baseCtx,
      'db-token'
    );

    expect(mockService.getQueriesSummary).toHaveBeenCalledWith(
      expect.objectContaining({ includeCompetitors: false })
    );
    expect(response.queries[0].competitors).toBeUndefined();
    expect(response._meta.include_competitors_effective).toBe(false);
    expect(response._meta.competitor_data_state).toBe('explicitly_excluded');
  });

  it('topics_performance defaults includeCompetitors to true and keeps competitors key even when empty', async () => {
    mockService.getTopicsSummary.mockResolvedValue([
      {
        topic: 'Awareness & Informational',
        query_count: 3,
        visibility_score: 61.2,
        share_of_answer_score: 93.3,
        mentions: 219,
        sentiment_score: 70.1,
        brand_presence_pct: 100,
        competitors: [],
      },
    ]);

    const response: any = await executeTopicsPerformance(baseInputs, baseCtx, 'db-token');

    expect(mockService.getTopicsSummary).toHaveBeenCalledWith(
      expect.objectContaining({ includeCompetitors: true })
    );
    expect(response.topics[0]).toHaveProperty('competitors');
    expect(response.topics[0].competitors).toEqual([]);
    expect(response._meta.include_competitors_effective).toBe(true);
    expect(response._meta.competitor_data_state).toBe('included_no_rows');
  });

  it('topics_performance reports explicitly_excluded when includeCompetitors=false', async () => {
    mockService.getTopicsSummary.mockResolvedValue([
      {
        topic: 'Awareness',
        query_count: 1,
        visibility_score: 50,
        share_of_answer_score: 40,
        mentions: 10,
        sentiment_score: 60,
        brand_presence_pct: 80,
        competitors: [{ name: 'Howdens', visibility_score: 52, soa_score: 41, sentiment_score: 58 }],
      },
    ]);

    const response: any = await executeTopicsPerformance(
      { ...baseInputs, includeCompetitors: false },
      baseCtx,
      'db-token'
    );

    expect(response.topics[0].competitors).toBeUndefined();
    expect(response._meta.include_competitors_effective).toBe(false);
    expect(response._meta.competitor_data_state).toBe('explicitly_excluded');
  });

  it('queries_collector_breakdown exposes include_competitors_effective and state', async () => {
    mockService.getQueryDetail.mockResolvedValue({
      query_text: 'magnet vs howdens kitchens?',
      topic: 'Awareness & Informational',
      overall: { visibility_score: 60, soa_score: 80 },
      per_collector: [
        {
          collector_type: 'Perplexity',
          brand_mentions: 2,
          brand_positions: [1],
          soa_score: 80,
          sentiment_score: 70,
          sentiment_label: 'positive',
          competitor_details: {
            Howdens: { visibility_score: 58, soa_score: 79, sentiment_score: 68 },
          },
        },
      ],
    });

    const response: any = await executeQueriesCollectorBreakdown(
      { ...baseInputs, queryText: 'magnet vs howdens kitchens?', includeCompetitors: true },
      baseCtx,
      'db-token'
    );

    expect(response._meta.include_competitors_effective).toBe(true);
    expect(response._meta.competitor_data_state).toBe('included_with_rows');
  });
});

