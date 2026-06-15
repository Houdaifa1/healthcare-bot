import { Module } from '@nestjs/common';
import { DoctorsService } from './doctors.service';
import { DoctorsController } from './doctors.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { WhatsAppModule } from 'src/whatsapp/whatsapp.module';
import { ClinicGuardService } from 'src/common/services/clinic-guard.service';

@Module({
  imports: [PrismaModule, WhatsAppModule],
  controllers: [DoctorsController],
  providers: [DoctorsService, ClinicGuardService],
})
export class DoctorsModule {}
