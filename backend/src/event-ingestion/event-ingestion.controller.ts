import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../admin/admin.guard';
import { EventIngestionService } from './event-ingestion.service';
import { StartPollingDto, IngestLedgerDto, HandleReorgDto } from './dto/event-ingestion.dto';

@ApiTags('Event Ingestion')
@Controller('event-ingestion')
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiBearerAuth()
export class EventIngestionController {
  constructor(private readonly eventIngestionService: EventIngestionService) {}

  @Post('start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start polling for Soroban events (admin only)' })
  @ApiResponse({ status: 200, description: 'Polling started successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin privileges required' })
  async startPolling(@Body() dto: StartPollingDto) {
    await this.eventIngestionService.startPolling(dto.contractId);
    return { message: 'Polling started', contractId: dto.contractId };
  }

  @Post('stop')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop polling for Soroban events (admin only)' })
  @ApiResponse({ status: 200, description: 'Polling stopped successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin privileges required' })
  async stopPolling() {
    this.eventIngestionService.stopPolling();
    return { message: 'Polling stopped' };
  }

  @Post('ingest')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ingest events from a specific ledger (admin only)' })
  @ApiResponse({ status: 200, description: 'Events ingested successfully' })
  @ApiResponse({ status: 400, description: 'Bad request — invalid contract ID or ledger' })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin privileges required' })
  async ingestLedger(@Body() dto: IngestLedgerDto) {
    const results = await this.eventIngestionService.ingestSingleLedger(dto.contractId, dto.ledger);
    return { processed: results.length, results };
  }

  @Post('reorg')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Handle chain reorg by reprocessing from a ledger (admin only)' })
  @ApiResponse({ status: 200, description: 'Reorg handled successfully' })
  @ApiResponse({ status: 400, description: 'Bad request — invalid contract ID or ledger' })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin privileges required' })
  async handleReorg(@Body() dto: HandleReorgDto) {
    await this.eventIngestionService.handleReorg(dto.contractId, dto.fromLedger);
    return { message: 'Reorg handled', contractId: dto.contractId, fromLedger: dto.fromLedger };
  }

  @Get('status')
  @ApiOperation({ summary: 'Get event ingestion status (admin only)' })
  @ApiResponse({ status: 200, description: 'Status retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin privileges required' })
  async getStatus() {
    return this.eventIngestionService.getStatus();
  }

  @Post('retry-failed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry all failed events (admin only)' })
  @ApiResponse({ status: 200, description: 'Failed events retried' })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin privileges required' })
  async retryFailedEvents() {
    const results = await this.eventIngestionService.retryFailedEvents();
    return { retried: results.length, results };
  }
}
