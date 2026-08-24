import { Module } from '@nestjs/common';
import { BookingRequestsService } from './booking-requests.service';
import { BookingRequestsController } from './booking-requests.controller';
import { WhatsAppModule } from '@integrations/whatsapp/whatsapp.module';

@Module({
  imports:      [WhatsAppModule],
  controllers:  [BookingRequestsController],
  providers:    [BookingRequestsService],
})
export class BookingRequestsModule {}
