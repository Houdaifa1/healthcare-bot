import { Module } from '@nestjs/common';
import { ClinOpsService } from './clinops.service';

@Module({
  providers: [ClinOpsService],
  exports: [ClinOpsService],
})
export class ClinOpsModule {}
