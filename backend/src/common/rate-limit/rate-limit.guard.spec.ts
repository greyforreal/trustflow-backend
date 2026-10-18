import { Controller, Get, INestApplication, Logger, Post } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Reflector, APP_GUARD } from '@nestjs/core';
import { HttpException, HttpStatus } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { RateLimitGuard } from './rate-limit.guard';
import { REDIS_CLIENT } from '../redis/redis.module';
import {
  SKIP_RATE_LIMIT,
  RATE_LIMIT_POINTS,
  RATE_LIMIT_DURATION,
  RATE_LIMIT_ON_REDIS_ERROR,
  RateLimitRedisErrorPolicy,
} from './rate-limit.decorator';
import { validateEnv, getConfig, TEST_ONLY_JWT_SECRET } from '../../config/env.config';
import { MetricsService } from '../../monitoring/metrics.service';

// recordAbuse() reads config.RATE_LIMIT_* and extractVerifiedWallet() reads
// config.JWT_SECRET, both of which require validateEnv() to have run first —
// normally done once in main.ts.
validateEnv();

const jwtService = new JwtService();

/** Signs a real JWT so tests can exercise RateLimitGuard's own verification path. */
function signToken(payload: { address?: string; sub?: string }, secret = TEST_ONLY_JWT_SECRET) {
  return jwtService.sign(payload, { secret, expiresIn: '1h' });
}

function mockContext(overrides?: {
  ip?: string;
  method?: string;
  url?: string;
  routePath?: string;
  user?: Record<string, string>;
  body?: Record<string, string>;
  query?: Record<string, string>;
  params?: Record<string, string>;
  headers?: Record<string, string>;
}) {
  const ip = overrides?.ip ?? '127.0.0.1';
  const url = overrides?.url ?? '/auth/challenge';
  const routePath = overrides?.routePath ?? '/auth/challenge';

  const handler = () => {};
  const cls = class Mock {};
  const response = { setHeader: jest.fn() };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const context: any = {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({
      getRequest: () => ({
        ip,
        method: overrides?.method ?? 'GET',
        url,
        route: { path: routePath },
        headers: overrides?.headers ?? {},
        connection: { remoteAddress: '::1' },
        user: overrides?.user,
        // body/query/params are intentionally still accepted here (and ignored by the
        // guard) so tests can prove caller-controlled fields never select a bucket.
        body: overrides?.body,
        query: overrides?.query,
        params: overrides?.params,
      }),
      getResponse: () => response,
    }),
  };

  return { context, response };
}

type PipelineResult = [Error | null, [number, number] | null];

/**
 * Mocks the single `redis.pipeline().rateLimitCheck(...).exec()` round trip the guard now
 * makes per request (one `rateLimitCheck` call queued per identity), in place of the old
 * `ttl`/`eval` sequence. `queueResults` sets what `exec()` resolves to for the *next* call;
 * each test queues one result array per `canActivate()` invocation.
 */
function createRedisMock() {
  const rateLimitCheck = jest.fn();
  let pending: PipelineResult[] = [];
  const pipelineObj = {
    rateLimitCheck: (...args: unknown[]) => {
      rateLimitCheck(...args);
      return pipelineObj;
    },
    exec: jest.fn(() => Promise.resolve(pending) as Promise<PipelineResult[]>),
  };

  return {
    defineCommand: jest.fn(),
    pipeline: jest.fn(() => pipelineObj),
    rateLimitCheck,
    pipelineExec: pipelineObj.exec,
    /** Queue the result `pipeline.exec()` resolves to for the next `canActivate()` call. */
    queueResults(results: PipelineResult[]) {
      pending = results;
    },
    /** Make every following `pipeline.exec()` reject, as when the connection is down. */
    failExec(error: Error) {
      pipelineObj.exec.mockImplementation(() => Promise.reject(error));
    },
    /** Make every following `pipeline.exec()` never settle, as when Redis stalls. */
    hangExec() {
      pipelineObj.exec.mockImplementation(() => new Promise<PipelineResult[]>(() => undefined));
    },
  };
}

function createReflector(overrides?: {
  skip?: boolean;
  points?: number;
  duration?: number;
  onRedisError?: RateLimitRedisErrorPolicy;
}) {
  return {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === SKIP_RATE_LIMIT) return overrides?.skip;
      if (key === RATE_LIMIT_POINTS) return overrides?.points;
      if (key === RATE_LIMIT_DURATION) return overrides?.duration;
      if (key === RATE_LIMIT_ON_REDIS_ERROR) return overrides?.onRedisError;
      return undefined;
    }),
  };
}

@Controller('rate-limit-test')
class RateLimitTestController {
  @Get('limited')
  getLimited() {
    return { ok: true };
  }

  @Post('wallet')
  postWallet() {
    return { ok: true };
  }
}

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;
  let mockRedis: ReturnType<typeof createRedisMock>;

  beforeEach(async () => {
    mockRedis = createRedisMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RateLimitGuard,
        {
          provide: REDIS_CLIENT,
          useValue: mockRedis,
        },
        {
          provide: Reflector,
          useValue: createReflector(),
        },
      ],
    }).compile();

    guard = module.get<RateLimitGuard>(RateLimitGuard);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.RATE_LIMIT_ABUSE_THRESHOLD;
    delete process.env.RATE_LIMIT_ABUSE_WINDOW_SECONDS;
    delete process.env.RATE_LIMIT_LOCKOUT_SECONDS;
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  describe('when Redis is not configured', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RateLimitGuard,
          { provide: REDIS_CLIENT, useValue: null },
          {
            provide: Reflector,
            useValue: createReflector(),
          },
        ],
      }).compile();

      guard = module.get<RateLimitGuard>(RateLimitGuard);
    });

    it('should allow request when redis is null', async () => {
      const { context } = mockContext();
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should warn once at startup, not on every request', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RateLimitGuard,
          { provide: REDIS_CLIENT, useValue: null },
          { provide: Reflector, useValue: createReflector() },
        ],
      }).compile();
      const disabledGuard = module.get<RateLimitGuard>(RateLimitGuard);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('Redis not configured — rate limiting disabled');

      for (let i = 0; i < 3; i++) {
        const { context } = mockContext();
        await expect(disabledGuard.canActivate(context)).resolves.toBe(true);
      }
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('when @SkipRateLimit is present', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RateLimitGuard,
          { provide: REDIS_CLIENT, useValue: mockRedis },
          {
            provide: Reflector,
            useValue: createReflector({ skip: true }),
          },
        ],
      }).compile();

      guard = module.get<RateLimitGuard>(RateLimitGuard);
    });

    it('should allow request without checking Redis', async () => {
      const { context } = mockContext();
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(mockRedis.pipeline).not.toHaveBeenCalled();
    });
  });

  describe('distributed token bucket', () => {
    it('should allow a request when the Redis bucket has tokens', async () => {
      mockRedis.queueResults([[null, [1, 0]]]);

      const { context } = mockContext();
      await expect(guard.canActivate(context)).resolves.toBe(true);

      expect(mockRedis.rateLimitCheck).toHaveBeenCalledWith(
        'ratelimit:{ip:127.0.0.1:get:_auth_challenge}:bucket',
        'ratelimit:{ip:127.0.0.1:get:_auth_challenge}:lockout',
        'ratelimit:{ip:127.0.0.1:get:_auth_challenge}:abuse',
        100,
        60_000,
        120_000,
        300_000,
        300,
        5,
        900,
        expect.any(String),
      );
    });

    it('should advertise RateLimit-* headers matching bucket state returned by Redis Lua script', async () => {
      mockRedis.queueResults([[null, [1, 42]]]); // allowed, 42 remaining

      const { context, response } = mockContext();
      await expect(guard.canActivate(context)).resolves.toBe(true);

      expect(response.setHeader).toHaveBeenCalledWith('RateLimit-Remaining', '42');
      expect(response.setHeader).toHaveBeenCalledWith('RateLimit-Reset', '0');
    });

    it('should apply custom decorator values to bucket capacity and refill duration', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RateLimitGuard,
          { provide: REDIS_CLIENT, useValue: mockRedis },
          { provide: Reflector, useValue: createReflector({ points: 10, duration: 5 }) },
        ],
      }).compile();
      const customGuard = module.get<RateLimitGuard>(RateLimitGuard);

      mockRedis.queueResults([[null, [1, 0]]]);

      const { context } = mockContext();
      await expect(customGuard.canActivate(context)).resolves.toBe(true);
      expect(mockRedis.rateLimitCheck).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        10,
        5_000,
        10_000,
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        expect.any(String),
      );
    });

    it('should enforce wallet and IP buckets when wallet identity is present', async () => {
      mockRedis.queueResults([
        [null, [1, 0]],
        [null, [1, 0]],
      ]);

      const { context } = mockContext({ user: { address: 'GABC123' } });
      await expect(guard.canActivate(context)).resolves.toBe(true);

      expect(mockRedis.rateLimitCheck).toHaveBeenCalledTimes(2);
      expect(mockRedis.rateLimitCheck).toHaveBeenNthCalledWith(
        2,
        'ratelimit:{wallet:gabc123:get:_auth_challenge}:bucket',
        'ratelimit:{wallet:gabc123:get:_auth_challenge}:lockout',
        'ratelimit:{wallet:gabc123:get:_auth_challenge}:abuse',
        100,
        60_000,
        120_000,
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        expect.any(String),
      );
      // Both identities are checked in a single pipeline — one round trip, not two.
      expect(mockRedis.pipeline).toHaveBeenCalledTimes(1);
      expect(mockRedis.pipelineExec).toHaveBeenCalledTimes(1);
    });

    it('should derive the wallet identity from a verified bearer token, since request.user is not yet populated when this global guard runs', async () => {
      mockRedis.queueResults([
        [null, [1, 0]],
        [null, [1, 0]],
      ]);

      const token = signToken({ address: 'GABC123', sub: 'GABC123' });
      const { context } = mockContext({ headers: { authorization: `Bearer ${token}` } });
      await expect(guard.canActivate(context)).resolves.toBe(true);

      expect(mockRedis.rateLimitCheck).toHaveBeenCalledTimes(2);
      expect(mockRedis.rateLimitCheck).toHaveBeenNthCalledWith(
        2,
        'ratelimit:{wallet:gabc123:get:_auth_challenge}:bucket',
        expect.any(String),
        expect.any(String),
        100,
        60_000,
        120_000,
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        expect.any(String),
      );
    });

    it('should fall back to IP-only limiting when the bearer token is missing, malformed, or signed with the wrong secret', async () => {
      const forgedToken = signToken(
        { address: 'GFORGED1', sub: 'GFORGED1' },
        'a-completely-different-secret',
      );
      const cases: Array<{ headers: Record<string, string> }> = [
        { headers: { authorization: 'Bearer not-a-real-token' } },
        { headers: { authorization: `Bearer ${forgedToken}` } },
        { headers: {} },
      ];

      for (const overrides of cases) {
        mockRedis.rateLimitCheck.mockClear();
        mockRedis.queueResults([[null, [1, 0]]]);
        const { context } = mockContext(overrides);
        await expect(guard.canActivate(context)).resolves.toBe(true);
        expect(mockRedis.rateLimitCheck).toHaveBeenCalledTimes(1);
      }
    });

    it('should never derive a wallet-scoped bucket from caller-controlled body/query/param fields, even when they are rotated per request', async () => {
      for (const suffix of ['1', '2', '3']) {
        mockRedis.rateLimitCheck.mockClear();
        mockRedis.queueResults([[null, [1, 0]]]);
        const { context } = mockContext({
          body: {
            address: `ATTACKER-BODY-${suffix}`,
            walletAddress: `ATTACKER-BODY-WALLET-${suffix}`,
          },
          query: {
            address: `ATTACKER-QUERY-${suffix}`,
            walletAddress: `ATTACKER-QUERY-WALLET-${suffix}`,
          },
          params: {
            address: `ATTACKER-PARAM-${suffix}`,
            walletAddress: `ATTACKER-PARAM-WALLET-${suffix}`,
          },
        });
        await expect(guard.canActivate(context)).resolves.toBe(true);

        // Only the IP-scoped bucket is ever checked — rotating the unverified
        // address on every request must not create a fresh wallet-scoped bucket.
        expect(mockRedis.rateLimitCheck).toHaveBeenCalledTimes(1);
        expect(mockRedis.rateLimitCheck).toHaveBeenCalledWith(
          'ratelimit:{ip:127.0.0.1:get:_auth_challenge}:bucket',
          expect.any(String),
          expect.any(String),
          100,
          60_000,
          120_000,
          expect.any(Number),
          expect.any(Number),
          expect.any(Number),
          expect.any(Number),
          expect.any(String),
        );
      }
    });

    it('should throw 429 and record abuse when the bucket is empty', async () => {
      mockRedis.queueResults([[null, [0, 12]]]);

      const { context } = mockContext();
      await expect(guard.canActivate(context)).rejects.toThrow(
        new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Too many requests - rate limit exceeded',
            retryAfter: 12,
            scope: 'ip:127.0.0.1',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );
      // Lockout check, bucket consume, and abuse recording are one call now — not two.
      expect(mockRedis.rateLimitCheck).toHaveBeenCalledTimes(1);
    });

    it('should lock out identities after repeated empty-bucket attempts', async () => {
      // The combined script applies the lockout itself once the abuse threshold is hit and
      // reports it back as the returned retryAfter — indistinguishable from JS's side from
      // any other rejection, which is the point of making this one atomic operation.
      mockRedis.queueResults([[null, [0, 900]]]);

      const { context } = mockContext();
      await expect(guard.canActivate(context)).rejects.toThrow(
        new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Too many requests - rate limit exceeded',
            retryAfter: 900,
            scope: 'ip:127.0.0.1',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );
      expect(mockRedis.rateLimitCheck).toHaveBeenCalledTimes(1);
    });

    it('should reject immediately while a lockout key exists', async () => {
      // The script itself short-circuits on an existing lockout key (PTTL check) before
      // touching the bucket — from JS's side this still surfaces as a single rejected call.
      mockRedis.queueResults([[null, [0, 45]]]);

      const { context } = mockContext();
      await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
      expect(mockRedis.rateLimitCheck).toHaveBeenCalledTimes(1);
    });

  });

  describe('when Redis fails', () => {
    let metrics: MetricsService;
    let warn: jest.SpyInstance;
    let error: jest.SpyInstance;

    async function makeGuard(onRedisError?: RateLimitRedisErrorPolicy) {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RateLimitGuard,
          MetricsService,
          { provide: REDIS_CLIENT, useValue: mockRedis },
          { provide: Reflector, useValue: createReflector({ onRedisError }) },
        ],
      }).compile();
      metrics = module.get(MetricsService);
      return module.get<RateLimitGuard>(RateLimitGuard);
    }

    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    const failures: Array<[string, () => void]> = [
      ['exec() rejecting', () => mockRedis.failExec(new Error('connection lost'))],
      [
        'a command error in the pipeline reply',
        () => mockRedis.queueResults([[new Error('READONLY'), null]]),
      ],
      ['a missing pipeline reply', () => mockRedis.queueResults([])],
      [
        'a malformed script reply',
        () => mockRedis.queueResults([[null, null as unknown as [number, number]]]),
      ],
    ];

    it.each(failures)(
      'should fail open by default on %s and count the error',
      async (_name, fail) => {
        const openGuard = await makeGuard();
        fail();

        const { context } = mockContext();
        await expect(openGuard.canActivate(context)).resolves.toBe(true);

        expect(metrics.getAll()).toEqual([
          {
            name: 'rate_limit_redis_error_total',
            value: 1,
            labels: { route: 'get:_auth_challenge', policy: 'allow' },
          },
        ]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('scope=ip'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('route=get:_auth_challenge'));
      },
    );

    it.each(failures)(
      'should answer 503 with Retry-After on %s when the policy is deny',
      async (_name, fail) => {
        const closedGuard = await makeGuard('deny');
        fail();

        const { context, response } = mockContext();
        const rejection = closedGuard.canActivate(context);
        await expect(rejection).rejects.toBeInstanceOf(HttpException);
        await expect(rejection).rejects.toMatchObject({
          status: HttpStatus.SERVICE_UNAVAILABLE,
          response: expect.objectContaining({ retryAfter: 5 }),
        });

        expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '5');
        expect(metrics.getAll()).toEqual([
          expect.objectContaining({
            name: 'rate_limit_redis_error_total',
            labels: { route: 'get:_auth_challenge', policy: 'deny' },
          }),
        ]);
        expect(error).toHaveBeenCalledTimes(1);
      },
    );

    it('should let the route policy override the global default in both directions', async () => {
      mockRedis.failExec(new Error('connection lost'));

      // Global default is allow (see EnvSchema), so a per-route deny must win over it.
      const routeDeny = await makeGuard('deny');
      await expect(routeDeny.canActivate(mockContext().context)).rejects.toMatchObject({
        status: HttpStatus.SERVICE_UNAVAILABLE,
      });

      // And with the global default flipped to deny, a per-route allow must win over it.
      const settings = getConfig() as { RATE_LIMIT_ON_REDIS_ERROR: string };
      const original = settings.RATE_LIMIT_ON_REDIS_ERROR;
      settings.RATE_LIMIT_ON_REDIS_ERROR = 'deny';
      try {
        const routeAllow = await makeGuard('allow');
        await expect(routeAllow.canActivate(mockContext().context)).resolves.toBe(true);

        const globalDeny = await makeGuard();
        await expect(globalDeny.canActivate(mockContext().context)).rejects.toMatchObject({
          status: HttpStatus.SERVICE_UNAVAILABLE,
        });
      } finally {
        settings.RATE_LIMIT_ON_REDIS_ERROR = original;
      }
    });

    it('should log a sustained outage once per interval but count every failure', async () => {
      const openGuard = await makeGuard();
      mockRedis.failExec(new Error('connection lost'));

      for (let i = 0; i < 5; i++) {
        await expect(openGuard.canActivate(mockContext().context)).resolves.toBe(true);
      }

      expect(warn).toHaveBeenCalledTimes(1);
      expect(metrics.getAll()[0]).toMatchObject({ value: 5 });

      const later = Date.now() + 31_000;
      jest.spyOn(Date, 'now').mockReturnValue(later);
      await expect(openGuard.canActivate(mockContext().context)).resolves.toBe(true);

      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('4 similar errors suppressed'));
    });

    it('should not hold the request while Redis stalls', async () => {
      const openGuard = await makeGuard();
      mockRedis.hangExec();
      // Leave nextTick/setImmediate real so Nest and promise plumbing keep flowing.
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      try {
        const pending = openGuard.canActivate(mockContext().context);
        await jest.advanceTimersByTimeAsync(1_000);

        await expect(pending).resolves.toBe(true);
        expect(metrics.getAll()[0]).toMatchObject({ name: 'rate_limit_redis_error_total' });
      } finally {
        jest.useRealTimers();
      }
    });

    it('should still surface a genuine 429 as 429, never as an outage', async () => {
      const closedGuard = await makeGuard('deny');
      mockRedis.queueResults([[null, [0, 12]]]);

      await expect(closedGuard.canActivate(mockContext().context)).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
      });
      expect(metrics.getAll()).toEqual([]);
    });
  });
});

describe('RateLimitGuard Supertest integration', () => {
  let app: INestApplication;
  let mockRedis: ReturnType<typeof createRedisMock>;

  beforeEach(async () => {
    mockRedis = createRedisMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RateLimitTestController],
      providers: [
        { provide: REDIS_CLIENT, useValue: mockRedis },
        {
          provide: APP_GUARD,
          useClass: RateLimitGuard,
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('should allow HTTP requests while shared Redis bucket allows them', async () => {
    mockRedis.queueResults([[null, [1, 0]]]);

    await request(app.getHttpServer()).get('/v1/rate-limit-test/limited').expect(200, { ok: true });
  });

  it('should return 429 with retry details when shared Redis bucket rejects', async () => {
    mockRedis.queueResults([[null, [0, 7]]]);

    const response = await request(app.getHttpServer()).get('/v1/rate-limit-test/limited').expect(429);

    expect(response.body).toMatchObject({
      statusCode: 429,
      message: 'Too many requests - rate limit exceeded',
      retryAfter: 7,
      scope: expect.stringMatching(/^ip:/),
    });
  });

  it('should evaluate both per-IP and per-wallet buckets when the request carries a verified bearer token', async () => {
    mockRedis.queueResults([
      [null, [1, 0]],
      [null, [1, 0]],
    ]);

    const token = signToken({ address: 'GABC123', sub: 'GABC123' });
    await request(app.getHttpServer())
      .post('/v1/rate-limit-test/wallet')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(201, { ok: true });

    expect(mockRedis.rateLimitCheck).toHaveBeenCalledTimes(2);
    expect(mockRedis.rateLimitCheck).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('ratelimit:{wallet:gabc123'),
      expect.any(String),
      expect.any(String),
      100,
      60_000,
      120_000,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(String),
    );
  });

  it('should not create a new wallet-scoped bucket when a client rotates an unverified walletAddress in the request body', async () => {
    mockRedis.queueResults([[null, [1, 0]]]);
    await request(app.getHttpServer())
      .post('/v1/rate-limit-test/wallet')
      .send({ walletAddress: 'ROTATED-1' })
      .expect(201, { ok: true });

    mockRedis.queueResults([[null, [1, 0]]]);
    await request(app.getHttpServer())
      .post('/v1/rate-limit-test/wallet')
      .send({ walletAddress: 'ROTATED-2' })
      .expect(201, { ok: true });

    // Neither unauthenticated request produces a wallet bucket — each only checks
    // its IP-scoped bucket once, regardless of the walletAddress supplied in the body.
    expect(mockRedis.rateLimitCheck).toHaveBeenCalledTimes(2);
    expect(mockRedis.rateLimitCheck).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('ratelimit:{ip:'),
      expect.any(String),
      expect.any(String),
      100,
      60_000,
      120_000,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(String),
    );
    expect(mockRedis.rateLimitCheck).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('ratelimit:{ip:'),
      expect.any(String),
      expect.any(String),
      100,
      60_000,
      120_000,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(String),
    );
  });
});
