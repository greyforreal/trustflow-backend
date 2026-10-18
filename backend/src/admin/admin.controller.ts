import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/auth.guard';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import {
  AnalyticsOverviewDto,
  DisputeAnalyticsDto,
  EscrowAnalyticsDto,
  GigAnalyticsDto,
  PaginatedEscrowAnalyticsDto,
} from './admin.dto';
import { DiscordService } from '../webhook/discord.service';

@ApiTags('Admin')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/analytics')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly discordService: DiscordService,
  ) {}

  @Get('overview')
  @ApiOperation({
    summary: 'System-wide analytics snapshot for protocol admins',
    description:
      'Aggregates escrow, gig, dispute, reputation, migration, and reconciliation state into a ' +
      'single dashboard payload. Every figure is computed on demand from the owning service — ' +
      'nothing is cached, so this always reflects current state. Restricted to addresses listed ' +
      'in `ADMIN_ADDRESSES`.',
  })
  @ApiResponse({ status: 200, type: AnalyticsOverviewDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Caller is authenticated but not an admin address' })
  getOverview() {
    return this.adminService.getOverview();
  }

  @Get('escrows')
  @ApiOperation({ summary: 'Escrow analytics: totals and status breakdown' })
  @ApiResponse({ status: 200, type: EscrowAnalyticsDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Caller is authenticated but not an admin address' })
  getEscrowAnalytics(@Query('limit') limit = 50, @Query('cursor') cursor?: string) {
    return this.adminService.getEscrowAnalytics(limit, cursor);
  }

  @Get('gigs')
  @ApiOperation({ summary: 'Gig solicitation analytics: totals and status breakdown' })
  @ApiResponse({ status: 200, type: GigAnalyticsDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Caller is authenticated but not an admin address' })
  getGigAnalytics() {
    return this.adminService.getGigAnalytics();
  }

  @Get('disputes')
  @ApiOperation({ summary: 'Dispute saga analytics: totals, step, and verdict breakdown' })
  @ApiResponse({ status: 200, type: DisputeAnalyticsDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Caller is authenticated but not an admin address' })
  getDisputeAnalytics() {
    return this.adminService.getDisputeAnalytics();
  }

  @Get('discord/failed-notifications')
  @ApiOperation({
    summary: 'List permanently failed Discord dispute notifications',
    description:
      'Returns the dead-letter map of dispute notifications that failed permanently after ' +
      'exhausting retries. Entries are automatically evicted after 7 days or when the map ' +
      'exceeds 1000 entries. Admin-only endpoint for monitoring notification delivery failures.',
  })
  @ApiResponse({
    status: 200,
    description: 'Map of dispute IDs to failure records (error message and timestamp)',
    schema: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          error: { type: 'string', description: 'Error message' },
          timestamp: { type: 'string', format: 'date-time', description: 'ISO 8601 timestamp' },
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Caller is authenticated but not an admin address' })
  getFailedDiscordNotifications() {
    const failures = this.discordService.getFailedNotifications();
    return Object.fromEntries(failures);
  }
}
