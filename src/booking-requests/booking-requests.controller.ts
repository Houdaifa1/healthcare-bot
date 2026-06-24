import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { BookingRequestsService } from './booking-requests.service';
import { ConfirmBookingRequestDto } from './dto/confirm-booking-request.dto';
import { JwtAuthGuard } from '../admin/auth/jwt-auth.guard';
import { BookingRequestStatus } from '@prisma/client';

@UseGuards(JwtAuthGuard)
@Controller('api/admin/v1/booking-requests')
export class BookingRequestsController {
  constructor(private readonly bookingRequestsService: BookingRequestsService) {}

  // GET /api/admin/v1/booking-requests
  @Get()
  findAll(
    @Request() req: any,
    @Query('campaignId') campaignId?: string,
    @Query('status')     status?: BookingRequestStatus,
  ) {
    return this.bookingRequestsService.findAll(req.user.clinicId, {
      campaignId,
      status,
    });
  }

  // GET /api/admin/v1/booking-requests/:id
  @Get(':id')
  findOne(@Request() req: any, @Param('id') id: string) {
    return this.bookingRequestsService.findOne(req.user.clinicId, id);
  }

  // POST /api/admin/v1/booking-requests/:id/confirm
  @Post(':id/confirm')
  confirm(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: ConfirmBookingRequestDto,
  ) {
    return this.bookingRequestsService.confirm(req.user.clinicId, id, dto);
  }

  // POST /api/admin/v1/booking-requests/:id/reject
  @Post(':id/reject')
  reject(@Request() req: any, @Param('id') id: string) {
    return this.bookingRequestsService.reject(req.user.clinicId, id);
  }
}