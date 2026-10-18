import 'ioredis';

declare module 'ioredis' {
  interface Redis {
    rateLimitCheck(
      bucketKey: string,
      lockoutKey: string,
      abuseKey: string,
      capacity: number,
      refillMs: number,
      bucketTtlMs: number,
      abuseWindowMs: number,
      abuseWindowSeconds: number,
      abuseThreshold: number,
      lockoutSeconds: number,
      member: string,
    ): Result<[number, number], Context>;
  }

  interface ChainableCommander {
    rateLimitCheck(
      bucketKey: string,
      lockoutKey: string,
      abuseKey: string,
      capacity: number,
      refillMs: number,
      bucketTtlMs: number,
      abuseWindowMs: number,
      abuseWindowSeconds: number,
      abuseThreshold: number,
      lockoutSeconds: number,
      member: string,
    ): ChainableCommander;
  }
}
