import {
  Controller,
  Get,
  Post,
  HttpCode,
  HttpStatus,
  Body,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

@Controller('api/admin/v1')
export class AuthController {
  constructor(
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
}