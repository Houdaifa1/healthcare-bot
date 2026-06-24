import { Module } from '@nestjs/common';
import { BookingRequestsService } from './booking-requests.service';
import { BookingRequestsController } from './booking-requests.controller';

@Module({
  controllers: [BookingRequestsController],
  providers:   [BookingRequestsService],
})
export class BookingRequestsModule {}