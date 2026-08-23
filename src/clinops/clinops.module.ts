import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ClinOpsService } from './clinops.service';

@Module({
  imports: [PrismaModule],
  providers: [ClinOpsService],
  exports: [ClinOpsService],
})
export class ClinOpsModule {}