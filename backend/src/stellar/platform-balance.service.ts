import { Injectable } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { Cron, CronExpression } from '@nestjs/schedule';
import { StellarService } from './stellar.service';
import { WebhookService } from '../webhook/webhook.service';
import { config } from '../config/env.config';

@Injectable()
export class PlatformBalanceService {
  private readonly logger = new SanitizedLogger(PlatformBalanceService.name);
  private lastAlertTime = 0;
  private readonly alertCooldownMs = 3600000; // 1 hour cooldown between alerts

  constructor(
    private readonly stellarService: StellarService,
    private readonly webhookService: WebhookService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async checkPlatformBalance(): Promise<void> {
    const platformAddress = config.STELLAR_PLATFORM_ADDRESS;
    if (!platformAddress) {
      this.logger.debug('STELLAR_PLATFORM_ADDRESS not configured, skipping balance check');
      return;
    }

    try {
      const balanceXlm = await this.stellarService.getBalance(platformAddress);
      const balance = parseFloat(balanceXlm);

      const lowBalanceThreshold = config.STELLAR_LOW_BALANCE_THRESHOLD;
      const criticalBalanceThreshold = config.STELLAR_CRITICAL_BALANCE_THRESHOLD;

      // Sanity check: if thresholds are invalid (NaN), log error and skip alerting
      if (isNaN(balance) || isNaN(lowBalanceThreshold) || isNaN(criticalBalanceThreshold)) {
        this.logger.error(
          `Invalid balance or threshold values: balance=${balance}, low=${lowBalanceThreshold}, critical=${criticalBalanceThreshold}`,
        );
        return;
      }

      if (balance <= criticalBalanceThreshold) {
        this.triggerAlert(
          platformAddress,
          balance,
          'CRITICAL',
          `Platform account balance critically low: ${balance} XLM (threshold: ${criticalBalanceThreshold} XLM)`,
        );
      } else if (balance <= lowBalanceThreshold) {
        this.triggerAlert(
          platformAddress,
          balance,
          'WARNING',
          `Platform account balance low: ${balance} XLM (threshold: ${lowBalanceThreshold} XLM)`,
        );
      } else {
        this.logger.debug(
          `Platform account balance healthy: ${balance} XLM (threshold: ${lowBalanceThreshold} XLM)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to check platform account balance: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private triggerAlert(
    address: string,
    balance: number,
    level: 'WARNING' | 'CRITICAL',
    message: string,
  ): void {
    const now = Date.now();
    if (now - this.lastAlertTime < this.alertCooldownMs) {
      this.logger.debug(
        `Alert cooldown active, skipping notification (last alert ${now - this.lastAlertTime}ms ago)`,
      );
      return;
    }

    this.lastAlertTime = now;
    this.logger.warn(message);

    this.webhookService
      .dispatch('platform.balance_alert', {
        level,
        address,
        balance,
        message,
        timestamp: new Date().toISOString(),
      })
      .catch(err => {
        this.logger.error(
          `Failed to dispatch platform balance alert: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
}
