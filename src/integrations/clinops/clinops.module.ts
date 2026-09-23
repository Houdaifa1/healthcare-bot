import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '@platform/database/prisma.module';
import { ClinOpsService } from './clinops.service';
import { CLINOPS_HTTP, ClinOpsHttpClient } from './clinops.http';

@Module({
  imports: [PrismaModule],
  providers: [
    // The live HTTP transport exists only when CLINOPS_MODE=live. In mock mode
    // it resolves to null, so a missing CLINOPS_BASE_URL / credentials can
    // never blow up a mock-mode boot, and ClinOpsService's mock branches never
    // touch it.
    {
      provide: CLINOPS_HTTP,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): ClinOpsHttpClient | null =>
        configService.get<string>('clinops.mode') === 'live'
          ? new ClinOpsHttpClient(configService)
          : null,
    },
    ClinOpsService,
  ],
  exports: [ClinOpsService],
})
export class ClinOpsModule {}
