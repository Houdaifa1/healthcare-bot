import { Module } from '@nestjs/common';
import { ClinicService } from './clinic.service';
import { ClinicController } from './clinic.controller';
import { PrismaModule } from '@platform/database/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [ClinicService],
  controllers: [ClinicController],
})
export class ClinicModule {}