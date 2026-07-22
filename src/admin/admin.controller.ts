import {
  Controller,
  Get,
  Post,
  HttpCode,
  HttpStatus,
  Body,
  UseGuards,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { AuthService } from './auth/auth.service';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { LoginDto } from './dto';

@Controller('api/admin/v1')
export class AdminController {
  constructor(
    private adminService: AdminService,
    private authService: AuthService,
  ) {}

  // ─── Auth ─────────────────────────────────────────────
  // POST /api/admin/v1/auth/login
  @Post('auth/login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  // ─── Health ───────────────────────────────────────────
  // GET /api/admin/v1/health
  @Get('health')
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  // ─── Dashboard ────────────────────────────────────────
  // GET /api/admin/v1/stats
  @Get('stats')
  @UseGuards(JwtAuthGuard)
  getStats() {
    return this.adminService.getStats();
  }
}
