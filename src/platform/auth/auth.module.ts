import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { PrismaModule } from '@platform/database/prisma.module';
import { SessionsModule } from '@platform/cache/sessions.module';
import { ThrottlerModule } from '@nestjs/throttler';

// The auth half of the dissolved AdminModule. The clinic, bot-messages and
// faqs modules it used to aggregate are now imported directly by AppModule —
// each already declares its own dependencies, so nothing was lost in the split.
@Module({
  imports: [
    PrismaModule,
    SessionsModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 5 }]),
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '7d' },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
})
export class AuthModule {}
