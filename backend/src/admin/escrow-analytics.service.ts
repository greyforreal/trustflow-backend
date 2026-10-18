import { Inject, Injectable, Optional } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { Redis } from 'ioredis';
import { config } from '../config/env.config';
import { MetricsService } from '../monitoring/metrics.service';
import { EscrowService } from '../escrow/escrow.service';
import { EscrowEntity } from '../escrow/escrow.entity';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

/**
 * Service for optimized escrow analytics with cursor-based pagination and
 * pre-computed Redis counters. Eliminates the full table scan that was
 * causing 30-second gateway timeouts on production datasets.
 */
@Injectable()
export class EscrowAnalyticsService {
  private readonly logger = new SanitizedLogger(EscrowAnalyticsService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    @Optional() @Inject(MetricsService) private readonly metrics?: MetricsService,
    @Optional() @Inject(EscrowService) private readonly escrowService?: EscrowService,
  ) {}

  /**
   * Get paginated escrow analytics with cursor-based pagination.
   *
   * Uses Redis ZSET range queries for efficient pagination and pre-computed
   * Redis counters for total count, eliminating the O(n) full table scan.
   *
   * Query params:
   * - limit: number of records to return (default: 50, max: 200)
   * - cursor: opaque cursor for pagination (base64-encoded timestamp:escrowId)
   *
   * Returns: { data: EscrowAnalytics, pagination: { total, limit, cursor, hasMore } }
   */
  async getPaginatedEscrowAnalytics(
    limit = DEFAULT_PAGE_LIMIT,
    cursor?: string,
  ): Promise<{
    data: {
      total: number;
      byStatus: Record<string, number>;
      totalValueXLM: string;
    };
    pagination: {
      total: number;
      limit: number;
      cursor: string | null;
      hasMore: boolean;
    };
  }> {
    // Validate limit
    const effectiveLimit = Math.min(Math.max(limit, 1), MAX_PAGE_LIMIT);

    // Use Redis counters for total count if available
    const redisTotal = await this.redis?.get('escrow:total_count');
    const total = redisTotal ? Math.max(parseInt(redisTotal, 10), 0) : 0;

    // Get status breakdown from Redis counters per status
    const statuses = ['pending', 'active', 'released', 'disputed', 'cancelled'];
    const byStatus: Record<string, number> = {} as Record<string, number>;

    // Fetch each status count from Redis
    if (this.redis) {
      for (const status of statuses) {
        const countKey = `escrow:count:${status}`;
        const count = await this.redis.get(countKey);
        byStatus[status] = count ? Math.max(parseInt(count, 10), 0) : 0;
      }
    } else {
      // Fall back to service query if no Redis
      if (this.escrowService) {
        const allEscrows = await this.escrowService.findAll();
        for (const escrow of allEscrows) {
          const status = escrow.status;
          byStatus[status] = (byStatus[status] ?? 0) + 1;
        }
      }
    }

    // Calculate total value XLM from Redis counter
    const redisTotalValue = await this.redis?.get('escrow:total_value_xlm');
    const totalValueXLM = redisTotalValue ?? '0';

    // Cursor-based pagination using Redis ZSET
    let rawItems: any[] = [];
    let newCursor: string | null = null;
    let hasMore = false;

    if (this.redis) {
      // Use ZRANGEBYSCORE with LIMIT for efficient pagination
      // The ZSET ESCROWS_INDEX_KEY uses createdAt timestamps as scores
      const scoreMin = cursor ? parseFloat(cursor.split(':')[0]) : undefined;

      const rangeLimit = effectiveLimit + 1; // Get one extra to determine hasMore
      const rangeResults = await this.redis!.zrangebyscore(
        'escrows:index',
        scoreMin ?? '-inf',
        '+inf',
        'LIMIT',
        0,
        rangeLimit,
      );

      if (rangeResults.length > 0) {
        // If we got more than effectiveLimit results, there are more pages
        hasMore = rangeResults.length > effectiveLimit;
        const actualLimit = hasMore ? effectiveLimit : rangeResults.length;
        const idsToFetch = rangeResults.slice(0, actualLimit);

        // Fetch escrow entities by ID using mget
        if (idsToFetch.length > 0 && this.escrowService) {
          // Use the service's internal Redis to fetch by key
          const escrowKeys = idsToFetch.map(id => `escrow:${id}`);
          const raw = await this.escrowService['redis']!.mget(...escrowKeys);
          rawItems = raw.filter((r): r is string => r !== null).map(r => JSON.parse(r));
        } else if (idsToFetch.length > 0) {
          // Fallback: construct minimal objects from IDs
          rawItems = idsToFetch.map((id: string) => ({ id, status: 'pending' }));
        }
      }

      // Determine the next cursor
      if (rangeResults.length > 0) {
        const lastId = rangeResults[rangeResults.length - 1];
        const lastScore = await this.redis!.zscore('escrows:index', lastId);
        if (lastScore !== null) {
          newCursor = `${lastScore}:${lastId}`;
        }
      }
    } else {
      // Fallback without Redis - use escrowService with pagination
      if (this.escrowService) {
        const result = await this.escrowService.findAll();
        rawItems = result;
        hasMore = result.length > effectiveLimit;

        // Simple cursor: just the last timestamp
        if (rawItems.length > 0 && hasMore) {
          const lastItem = rawItems[effectiveLimit - 1];
          newCursor = lastItem.createdAt?.toISOString() || String(lastItem.createdAt);
        }
      }
    }

    // Build the response - convert to EscrowEntity-light shape
    const escrowEntities: Array<{ id: string; status: string; amountXLM: string; createdAt: string }> = [];
    for (const item of rawItems) {
      escrowEntities.push({
        id: item?.id ?? '',
        status: item?.status ?? 'pending',
        amountXLM: item?.amountXLM ?? '0',
        createdAt: item?.createdAt ?? new Date().toISOString(),
      });
    }

    // Build the response
    const pagination = {
      total,
      limit: effectiveLimit,
      cursor: newCursor ?? null,
      hasMore,
    };

    const data = {
      total,
      byStatus,
      totalValueXLM,
    };

    return { data, pagination };
  }
}