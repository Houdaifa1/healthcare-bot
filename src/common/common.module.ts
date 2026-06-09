import { Global, Module } from '@nestjs/common';
import { ClinicGuardService } from './services/clinic-guard.service';

@Global()
@Module({
  providers: [ClinicGuardService],
  exports: [ClinicGuardService],
})
export class CommonModule {}