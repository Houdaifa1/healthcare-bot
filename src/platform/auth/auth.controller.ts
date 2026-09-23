import {
  Controller,
  Get,
  Post,
  HttpCode,
  HttpStatus,
  Body,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { PrismaService } from '@platform/database/prisma.service';
import { SessionsService } from '@platform/cache/sessions.service';

@Controller('api/admin/v1')
export class AuthController {
  constructor(
    private authService: AuthService,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  // ─── Auth ─────────────────────────────────────────────
  // POST /api/admin/v1/auth/login
  @Post('auth/login')
  @UseGuards(ThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  // ─── Health ───────────────────────────────────────────
  // GET /api/admin/v1/health
  @Get('health')
  async health() {
    try {
      await Promise.all([
        this.prisma.$queryRaw`SELECT 1`,
        this.sessions.getClient().ping(),
      ]);
    } catch {
      throw new ServiceUnavailableException('Database or Redis unavailable');
    }
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
