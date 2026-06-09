import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ClinicService } from './clinic.service';
import { UpdateClinicDto } from './dto/update-clinic.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('api/admin/v1/clinic')
export class ClinicController {
  constructor(private readonly clinicService: ClinicService) {}

  @Get()
  getClinic() {
    // Assuming a single clinic, or you might get the id from user or other context
    return this.clinicService.getClinic('main'); // Or a dynamic ID
  }

  @Patch(':id')
  updateClinic(
    @Param('id') id: string,
    @Body() updateClinicDto: UpdateClinicDto,
  ) {
    return this.clinicService.updateClinic(id, updateClinicDto);
  }
}
