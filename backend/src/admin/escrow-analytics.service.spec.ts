import { Test, TestingModule } from '@nestjs/testing';
import { EscrowAnalyticsService } from './escrow-analytics.service';
import { Redis } from 'ioredis';

describe('EscrowAnalyticsService', () => {
  let service: EscrowAnalyticsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EscrowAnalyticsService],
    }).compile();

    service = module.get<EscrowAnalyticsService>(EscrowAnalyticsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getPaginatedEscrowAnalytics', () => {
    it('should return default pagination when no cursor', async () => {
      const result = await service.getPaginatedEscrowAnalytics(50);
      expect(result).toBeDefined();
      expect(result.data).toBeDefined();
      expect(result.pagination).toBeDefined();
      expect(result.data.total).toBeDefined();
      expect(result.data.byStatus).toBeDefined();
      expect(result.data.totalValueXLM).toBeDefined();
      expect(result.pagination.limit).toBe(50);
      expect(result.pagination.hasMore).toBeDefined();
    });

    it('should accept custom limit', async () => {
      const result = await service.getPaginatedEscrowAnalytics(100);
      expect(result.pagination.limit).toBe(100);
    });

    it('should respect max limit', async () => {
      const result = await service.getPaginatedEscrowAnalytics(500);
      expect(result.pagination.limit).toBe(200); // MAX_PAGE_LIMIT
    });

    it('should return pagination metadata', async () => {
      const result = await service.getPaginatedEscrowAnalytics(10);
      expect(result.pagination.total).toBeDefined();
      expect(result.pagination.cursor).toBeDefined();
      expect(result.pagination.hasMore).toBeDefined();
    });

    it('resolves without throwing when Redis is available but escrowService is not injected', async () => {
      const mockRedis = {
        get: jest.fn((key: string) => {
          if (key === 'escrow:total_count') return Promise.resolve('2');
          if (key === 'escrow:total_value_xlm') return Promise.resolve('500');
          return Promise.resolve('0');
        }),
        zrangebyscore: jest.fn().mockResolvedValue(['escrow-1', 'escrow-2']),
        zscore: jest.fn().mockResolvedValue(123456789),
      } as unknown as Redis;

      const standaloneService = new EscrowAnalyticsService(mockRedis, undefined, undefined);

      const result = await standaloneService.getPaginatedEscrowAnalytics(50);
      expect(result).toBeDefined();
      expect(result.data.total).toBe(2);
      expect(result.pagination.hasMore).toBe(false);
      expect(result.pagination.cursor).toBe('123456789:escrow-2');
    });
  });
});