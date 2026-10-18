import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { IpfsPinningService } from './ipfs-pinning.service';
import { PinContentDto, PinRecordResponseDto } from './ipfs-pinning.dto';
import { ProviderHealthService } from './provider-health.service';
import { Inject, Optional } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../admin/admin.guard';

@ApiTags('IPFS Pinning')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('ipfs/pins')
export class IpfsPinningController {
  constructor(
    private readonly pinningService: IpfsPinningService,
    @Optional() @Inject(ProviderHealthService) private readonly providerHealth?: ProviderHealthService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Pin a deliverable across multiple IPFS providers',
    description:
      'Computes the CIDv1 content hash of the supplied bytes and pins them to providers in priority ' +
      'order until `replicationFactor` providers succeed, automatically failing over to the next ' +
      'provider whenever one fails to pin or fails post-pin verification.',
  })
  @ApiResponse({ status: 201, type: PinRecordResponseDto })
  @ApiResponse({ status: 400, description: 'expectedCid does not match the computed content hash' })
  @ApiResponse({ status: 503, description: 'Every registered provider failed to pin the content' })
  pin(@Body() dto: PinContentDto) {
    return this.pinningService.pinContent(dto);
  }

  @Get()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'List all pin records (admin only)' })
  @ApiResponse({ status: 200, type: [PinRecordResponseDto] })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin privileges required' })
  findAll() {
    return this.pinningService.findAll();
  }

  @Get('health')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Get provider health status' })
  @ApiResponse({ status: 200, type: Object })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin privileges required' })
  async getProviderHealth() {
    if (!this.providerHealth) {
      return { error: 'Provider health service not available' };
    }
    const providers = ['pinata', 'infura', 'web3storage'];
    const health = await this.providerHealth.getAllProviderHealth(providers);
    return { providers: health };
  }

  @Get(':cid')
  @ApiOperation({ summary: 'Get a pin record by CID' })
  @ApiParam({ name: 'cid', example: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' })
  @ApiResponse({ status: 200, type: PinRecordResponseDto })
  @ApiResponse({ status: 404, description: 'Pin record not found' })
  findOne(@Param('cid') cid: string) {
    return this.pinningService.findByCid(cid);
  }

  @Post(':cid/verify')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-verify pin durability and top up replication if degraded (admin only)',
    description:
      'Re-checks every provider believed to hold the pin and, if replication has dropped below the ' +
      'configured factor, attempts to restore it via any remaining providers. The re-pin worker calls ' +
      'this same logic automatically on a schedule; this endpoint triggers it on demand.',
  })
  @ApiParam({ name: 'cid', example: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' })
  @ApiResponse({ status: 200, type: PinRecordResponseDto })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin privileges required' })
  @ApiResponse({ status: 404, description: 'Pin record not found' })
  verify(@Param('cid') cid: string) {
    return this.pinningService.reconcile(cid);
  }

  @Delete(':cid')
  @ApiOperation({
    summary: 'Unpin content from every provider currently holding it',
    description:
      'The record only becomes `UNPINNED` (and `ipfs.pin.removed` only fires) once every provider ' +
      'has released the pin. If a provider fails, the record moves to `UNPINNING`, that provider ' +
      'stays `PINNED` with `lastError` set, and a 502 lists the per-provider results. Repeat the ' +
      'request to retry only the providers that still hold the pin.',
  })
  @ApiParam({ name: 'cid', example: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' })
  @ApiResponse({ status: 200, type: PinRecordResponseDto })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin privileges required' })
  @ApiResponse({ status: 404, description: 'Pin record not found' })
  @ApiResponse({
    status: 502,
    description:
      'At least one provider failed to release the pin; the response body carries the per-provider results',
  })
  unpin(@Param('cid') cid: string) {
    return this.pinningService.unpin(cid);
  }
}

  @Post('providers/:name/health/reset')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reset provider health status (admin only)',
    description:
      'Clears accumulated health metrics for a provider, allowing it to recover from FAILED status. ' +
      'Useful after manual recovery or to reset after a temporary outage.',
  })
  @ApiParam({ name: 'name', example: 'pinata', description: 'Provider name' })
  @ApiResponse({ status: 200, description: 'Provider health reset successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin privileges required' })
  async resetProviderHealth(@Param('name') name: string) {
    if (!this.providerHealth) {
      return { error: 'Provider health service not available' };
    }
    await this.providerHealth.resetProviderHealth(name);
    return { message: `Health metrics reset for provider: ${name}` };
  }
