import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
} from '@nestjs/common';
import { FaqsService } from './faqs.service';
import { CreateFaqDto } from './dto/create-faq.dto';
import { UpdateFaqDto } from './dto/update-faq.dto';
import { JwtAuthGuard } from '@platform/auth/jwt-auth.guard';
import { CurrentUser } from '@platform/shared/decorators/current-user.decorator';
import type { AuthUser } from '@platform/shared/types/auth-user.type';
import { Language } from '@prisma/client';

@UseGuards(JwtAuthGuard)
@Controller('api/admin/v1/faqs')
export class FaqsController {
  constructor(private readonly faqsService: FaqsService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body() createFaqDto: CreateFaqDto,
  ) {
    return this.faqsService.create(user.clinicId, createFaqDto);
  }

  @Get()
  findAll(
    @CurrentUser() user: AuthUser,
    @Query('language') language?: Language,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.faqsService.findAll(user.clinicId, language, includeInactive === 'true');
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateFaqDto: UpdateFaqDto) {
    return this.faqsService.update(id, updateFaqDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.faqsService.remove(id);
  }

  @Delete(':id/hard')
  hardRemove(@Param('id') id: string) {
    return this.faqsService.hardRemove(id);
  }
}