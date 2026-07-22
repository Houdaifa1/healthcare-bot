import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CampaignService } from './campaign.service';

@Injectable()
export class CampaignSchedulerService {
  private readonly logger = new Logger(CampaignSchedulerService.name);

  constructor(private readonly campaignService: CampaignService) {}

  /**
   * Runs every minute. Finds SCHEDULED campaigns whose scheduledStartAt
   * has passed and triggers the actual launch (patient fetch + job queue).
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async handleScheduledCampaigns(): Promise<void> {
    try {
      await this.campaignService.executeScheduledCampaigns();
    } catch (err: any) {
      this.logger.error(`Scheduler error: ${err.message}`);
    }
  }
}
