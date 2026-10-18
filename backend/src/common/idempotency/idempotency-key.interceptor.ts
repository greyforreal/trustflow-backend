import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of } from 'rxjs';
import { catchError, concatMap } from 'rxjs/operators';
import { IDEMPOTENT_KEY } from './idempotency-key.decorator';
import { IdempotencyKeyService } from './idempotency-key.service';
import { MetricsService } from '../../monitoring/metrics.service';

/**
 * Headers Express/Nest manage automatically. Replaying them from a cached
 * response would fight with values the framework recomputes for the replay
 * itself (e.g. Content-Length for the re-serialized body).
 */
const NON_REPLAYABLE_HEADERS = new Set([
  'content-length',
  'connection',
  'date',
  'keep-alive',
  'transfer-encoding',
  'x-powered-by',
  'etag',
]);

/**
 * Global interceptor that enforces idempotency on endpoints decorated with
 * {@link Idempotent}. Outcomes per request:
 *
 * 1. **No Idempotency-Key header** — pass through unchanged (backward compatible).
 * 2. **Key not seen before** — atomically claims the key (Redis `SET NX`) and
 *    runs the handler. On success the response (status, body, and a small
 *    set of headers) is cached; on failure the claim is released so retries
 *    are not stuck as `pending` until the TTL expires.
 * 3. **Key seen before, same body, completed** — replay the cached response.
 * 4. **Key seen before, different body** — 422 Unprocessable Entity.
 * 5. **Key seen before, still pending (concurrent duplicate request)** —
 *    409 Conflict; the original request is still in flight.
 *
 * The claim is stored under `(endpoint, key)`, where `endpoint` includes the
 * HTTP method and route path, so the same Idempotency-Key value used against
 * two different endpoints (e.g. POST /gigs and POST /escrows) never collides.
 */
@Injectable()
export class IdempotencyKeyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotencyService: IdempotencyKeyService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const isIdempotent = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!isIdempotent) return next.handle();

    const request = context.switchToHttp().getRequest();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next.handle();

    const idempotencyKey = request.headers['idempotency-key'] as string | undefined;

    if (!idempotencyKey) return next.handle();

    const scope = request.user?.sub ?? request.ip ?? 'anonymous';
    const routePath = `${request.method}:${request.route?.path ?? request.url}`;
    const endpoint = `${scope}:${routePath}`;
    const requestHash = IdempotencyKeyService.hashBody(request.body);

    const claimResult = await this.idempotencyService.claim(endpoint, idempotencyKey, requestHash);

    if (!claimResult.claimed) {
      const { record } = claimResult;

      if (!record) {
        // Lost the claim race but the record vanished (e.g. TTL race) —
        // degrade to pass-through rather than block the request.
        return next.handle();
      }

      if (record.requestHash !== requestHash) {
        this.metrics?.increment('idempotency_key_mismatch_total', { endpoint: routePath });
        throw new HttpException(
          {
            statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
            message: 'Idempotency key has already been used with a different request payload',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      if (record.status === 'pending') {
        this.metrics?.increment('idempotency_conflict_total', { endpoint: routePath });
        throw new HttpException(
          {
            statusCode: HttpStatus.CONFLICT,
            message: 'A request with this idempotency key is already being processed',
          },
          HttpStatus.CONFLICT,
        );
      }

      const response = context.switchToHttp().getResponse();
      response.status(record.statusCode ?? HttpStatus.OK);
      for (const [name, value] of Object.entries(record.headers ?? {})) {
        response.setHeader(name, value);
      }
      return of(record.body);
    }

    return next.handle().pipe(
      concatMap(async (responseBody: unknown) => {
        const response = context.switchToHttp().getResponse();
        if (response.statusCode >= 400) {
          await this.idempotencyService.release(endpoint, idempotencyKey);
        } else {
          await this.idempotencyService.finalize(
            endpoint,
            idempotencyKey,
            requestHash,
            response.statusCode,
            responseBody,
            this.capturedHeaders(response),
          );
        }
        return responseBody;
      }),
      catchError(async err => {
        await this.idempotencyService.release(endpoint, idempotencyKey);
        throw err;
      }),
    );
  }

  private capturedHeaders(response: {
    getHeaders?: () => Record<string, unknown>;
  }): Record<string, string> {
    const headers = response.getHeaders?.() ?? {};
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined || NON_REPLAYABLE_HEADERS.has(name.toLowerCase())) continue;
      result[name] = String(value);
    }
    return result;
  }
}
